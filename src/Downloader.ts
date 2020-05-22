import md5 from 'md5';
import * as path from 'path';
import * as urlParser from 'url';
import deepmerge from 'deepmerge';
import type { BackoffStrategy } from 'backoff';
import * as backoff from 'backoff';
import * as imagemin from 'imagemin';
import ServiceRunner from 'service-runner';
import imageminAdvPng from 'imagemin-advpng';
import axios, { AxiosRequestConfig } from 'axios';
import imageminPngquant from 'imagemin-pngquant';
import imageminGifsicle from 'imagemin-gifsicle';
import imageminJpegoptim from 'imagemin-jpegoptim';

import {
  DB_ERROR,
  FIND_HTTP_REGEX,
  MIME_IMAGE_REGEX,
  normalizeMwResponse,
  objToQueryString,
  readFilePromise,
  renderArticle,
  URL_IMAGE_REGEX,
  writeFilePromise
} from './util';
import S3 from './S3';
import { Dump } from './Dump';
import logger from './Logger';
import MediaWiki from './MediaWiki';


const imageminOptions = {
  plugins: [
    // imageminOptiPng(),
    imageminPngquant({ speed: 3, strip: true, dithering: 0 }),
    imageminAdvPng({ optimizationLevel: 4, iterations: 5 }),
    imageminJpegoptim({ max: 60, stripAll: true }),
    // imageminJpegtran(),
    imageminGifsicle({ optimizationLevel: 3, colors: 64 }),
  ],
};

interface DownloaderOpts {
  mw: MediaWiki;
  uaString: string;
  speed: number;
  reqTimeout: number;
  useDownloadCache: boolean;
  downloadCacheDirectory?: string;
  noLocalParserFallback: boolean;
  forceLocalParsoid: boolean;
  optimisationCacheUrl: string;
  s3?: S3;
  backoffOptions?: BackoffOptions;
}

interface BackoffOptions {
  strategy: BackoffStrategy;
  failAfter: number;
  retryIf: (error?: any) => boolean;
  backoffHandler: (number: number, delay: number, error?: any) => void;
}

interface MWCapabilities {
  parsoidAvailable: boolean;
  mcsAvailable: boolean;
  coordinatesAvailable: boolean;
}


class Downloader {
  public readonly mw: MediaWiki;
  public loginCookie: string = '';
  public readonly speed: number;
  public readonly useDownloadCache: boolean;
  public downloadCacheDirectory?: string;
  public mcsUrl: string;

  private readonly uaString: string;
  private activeRequests = 0;
  private maxActiveRequests = 1;
  private readonly requestTimeout: number;
  private readonly noLocalParserFallback: boolean = false;
  private readonly forceLocalParsoid: boolean = false;
  private forceParsoidFallback: boolean = false;
  private readonly urlPartCache: KVS<string> = {};
  private readonly backoffOptions: BackoffOptions;
  private readonly optimisationCacheUrl: string;
  private parsoidFallbackUrl: string;
  private s3: S3;
  private mwCapabilities: MWCapabilities; // todo move to MW


  constructor({ mw, uaString, speed, reqTimeout, useDownloadCache, downloadCacheDirectory, noLocalParserFallback, forceLocalParsoid, optimisationCacheUrl, s3, backoffOptions }: DownloaderOpts) {
    this.mw = mw;
    this.uaString = uaString;
    this.speed = speed;
    this.maxActiveRequests = speed * 10;
    this.requestTimeout = reqTimeout;
    this.loginCookie = '';
    this.useDownloadCache = useDownloadCache;
    this.downloadCacheDirectory = downloadCacheDirectory;
    this.noLocalParserFallback = noLocalParserFallback;
    this.forceLocalParsoid = forceLocalParsoid;
    this.optimisationCacheUrl = optimisationCacheUrl;
    this.s3 = s3;
    this.mwCapabilities = {
      parsoidAvailable: true,
      mcsAvailable: true,
      coordinatesAvailable: true,
    };

    this.backoffOptions =  {
      strategy: new backoff.ExponentialStrategy(),
      failAfter: 7,
      retryIf: (err: any) => err.code === 'ECONNABORTED' || err.response?.status !== 404,
      backoffHandler: (number: number, delay: number) => {
        logger.info(`[backoff] #${number} after ${delay} ms`);
      },
      ...backoffOptions,
    };

    this.mcsUrl = `${this.mw.base}api/rest_v1/page/mobile-sections/`;
    this.parsoidFallbackUrl = `${this.mw.apiUrl}action=visualeditor&mobileformat=html&format=json&paction=parse&page=`;
  }

  public serializeUrl(url: string): string {
    const { path } = urlParser.parse(url);
    const cacheablePart = url.replace(path, '');
    const cacheEntry = Object.entries(this.urlPartCache).find(([cacheId, value]) => value === cacheablePart);
    let cacheKey;
    if (!cacheEntry) {
      const cacheId = String(Object.keys(this.urlPartCache).length + 1);
      this.urlPartCache[cacheId] = cacheablePart;
      cacheKey = `_${cacheId}_`;
    } else {
      cacheKey = `_${cacheEntry[0]}_`;
    }
    return `${cacheKey}${path}`;
  }

  public deserializeUrl(url: string): string {
    if (!url.startsWith('_')) return url;
    const [, cacheId, ...pathParts] = url.split('_');
    const path = pathParts.join('_');
    const cachedPart = this.urlPartCache[cacheId];
    return `${cachedPart}${path}`;
  }

  public async checkCapabilities(): Promise<void> {
    try {
      const mcsMainPageQuery = await this.getJSON<any>(`${this.mcsUrl}${encodeURIComponent(this.mw.metaData.mainPage)}`);
      this.mwCapabilities.mcsAvailable = !!mcsMainPageQuery.lead;
    } catch (err) {
      this.mwCapabilities.mcsAvailable = false;
      logger.warn(`Failed to get remote MCS`);
    }

    if (!this.forceLocalParsoid) {
      try {
        const parsoidMainPageQuery = await this.getJSON<any>(`${this.parsoidFallbackUrl}${encodeURIComponent(this.mw.metaData.mainPage)}`);
        this.mwCapabilities.parsoidAvailable = !!parsoidMainPageQuery.visualeditor.content;
      } catch (err) {
        this.mwCapabilities.parsoidAvailable = false;
        logger.warn(`Failed to get remote Parsoid`);
      }
    }

    if (!this.noLocalParserFallback) {
      if (!this.mwCapabilities.mcsAvailable || !this.mwCapabilities.parsoidAvailable) {
        logger.log(`Using local MCS and ${this.mwCapabilities.parsoidAvailable ? 'remote' : 'local'} Parsoid`);
        await this.initLocalServices();
        const domain = (urlParser.parse(this.mw.base)).host;
        this.mcsUrl = `http://localhost:6927/${domain}/v1/page/mobile-sections/`;

        if (!this.mwCapabilities.parsoidAvailable) {
          const webUrlHost = urlParser.parse(this.mw.webUrl).host;
          this.parsoidFallbackUrl = `http://localhost:8000/${webUrlHost}/v3/page/pagebundle/`;
        }
      } else {
        logger.log(`Using REST API`);
      }
    } else {
      logger.log(`Using remote MCS/Parsoid`);
    }

    // Coordinate fetching
    const reqOpts = objToQueryString({
      ...this.getArticleQueryOpts(),
    });
    const resp = await this.getJSON<MwApiResponse>(`${this.mw.apiUrl}${reqOpts}`);
    const isCoordinateWarning = resp.warnings && resp.warnings.query && (resp.warnings.query['*'] || '').includes('coordinates');
    if (isCoordinateWarning) {
      logger.info(`Coordinates not available on this wiki`);
      this.mwCapabilities.coordinatesAvailable = false;
    }
  }

  public isImageUrl (url: string): boolean {
    return !!URL_IMAGE_REGEX.exec(url);
  }

  public isMimeTypeImage (mimetype: string): boolean {
    return !!MIME_IMAGE_REGEX.exec(mimetype);
  }

  public stripHttpFromUrl (url: string): string {
    return url.replace(FIND_HTTP_REGEX, '');
  }

  public async initLocalServices(): Promise<void> {
    logger.log('Starting Parsoid & MCS');

    const runner = new ServiceRunner();

    await runner.start({
      num_workers: 0,
      services: [{
        name: 'parsoid',
        module: 'node_modules/parsoid/lib/index.js',
        entrypoint: 'apiServiceWorker',
        conf: {
          timeouts: {
            // request: 4 * 60 * 1000, // Default
            request: 8 * 60 * 1000,
          },
          limits: {
            wt2html: {
              // maxWikitextSize: 1000000, // Default
              maxWikitextSize: 1000000 * 4,
              // maxListItems: 30000, // Default
              maxListItems: 30000 * 4,
              // maxTableCells: 30000, // Default
              maxTableCells: 30000 * 4,
              // maxTransclusions: 10000, // Default
              maxTransclusions: 10000 * 4,
              // maxImages: 1000, // Default
              maxImages: 1000 * 4,
              // maxTokens: 1000000, // Default
              maxTokens: 1000000 * 4,
            },
          },
          mwApis: [{
            uri: this.mw.apiResolvedUrl,
          }],
        },
      }, {
        name: 'mcs',
        module: 'node_modules/service-mobileapp-node/app.js',
        conf: {
          port: 6927,
          mwapi_req: {
            method: 'post',
            uri: `https://{{domain}}${this.mw.apiResolvedPath}`,
            headers: {
              'user-agent': '{{user-agent}}',
            },
            body: '{{ default(request.query, {}) }}',
          },
          restbase_req: {
            method: '{{request.method}}',
            uri: 'http://localhost:8000/{{domain}}/v3/{+path}',
            query: '{{ default(request.query, {}) }}',
            headers: '{{request.headers}}',
            body: '{{request.body}}',
          },
        },
      }],
      logging: {
        level: 'info',
      },
    });
  }

  public query(query: string): KVS<any> {
    return this.getJSON(`${this.mw.apiUrl}${query}`);
  }

  public async getArticleDetailsIds(articleIds: string[], shouldGetThumbnail = false): Promise<KVS<ArticleDetail>> {
    let continuation: ContinueOpts;
    let result: QueryMwRet;

    while (true) {
      const queryOpts = {
        ...this.getArticleQueryOpts(shouldGetThumbnail),
        titles: articleIds.join('|'),
        ...(this.mwCapabilities.coordinatesAvailable ? { colimit: 'max' } : {}),
        ...(this.mw.getCategories ? {
          cllimit: 'max',
          clshow: '!hidden',
        } : {}),
        ...(continuation || {}),
      };
      const queryString = objToQueryString(queryOpts);
      const reqUrl = `${this.mw.apiUrl}${queryString}`;
      const resp = await this.getJSON<MwApiResponse>(reqUrl);
      Downloader.handleMWWarningsAndErrors(resp);

      let processedResponse = resp.query ? normalizeMwResponse(resp.query) : {};
      if (resp.continue) {
        continuation = resp.continue;
        const relevantDetails = this.stripNonContinuedProps(processedResponse);
        result = result === undefined ? relevantDetails : deepmerge(result, relevantDetails);
      } else {
        if (this.mw.getCategories) {
          processedResponse = await this.setArticleSubCategories(processedResponse);
        }
        result = result === undefined ? processedResponse : deepmerge(result, processedResponse);
        break;
      }
    }
    return this.mwRetToArticleDetail(result);
  }

  public async getArticleDetailsNS(ns: number, gapContinue: string = ''): Promise<{ gapContinue: string, articleDetails: KVS<ArticleDetail> }> {
    let queryContinuation: QueryContinueOpts;
    let result: QueryMwRet;
    let gCont: string = null;

    while (true) {
      const queryOpts: KVS<any> = {
        ...this.getArticleQueryOpts(),
        ...(this.mwCapabilities.coordinatesAvailable ? { colimit: 'max' } : {}),
        ...(this.mw.getCategories ? {
          cllimit: 'max',
          clshow: '!hidden',
        } : {}),
        rawcontinue: 'true',
        generator: 'allpages',
        gapfilterredir: 'nonredirects',
        gaplimit: 'max',
        gapnamespace: String(ns),
        gapcontinue: gapContinue
      };

      if (queryContinuation) {
        queryOpts.cocontinue = queryContinuation.coordinates?.cocontinue ?? queryOpts.cocontinue;
        queryOpts.clcontinue = queryContinuation.categories?.clcontinue ?? queryOpts.clcontinue;
        queryOpts.picontinue = queryContinuation.pageimages?.picontinue ?? queryOpts.picontinue;
        queryOpts.rdcontinue = queryContinuation.redirects?.rdcontinue ?? queryOpts.rdcontinue;
      }

      const queryString = objToQueryString(queryOpts);
      const reqUrl = `${this.mw.apiUrl}${queryString}`;

      const resp = await this.getJSON<MwApiResponse>(reqUrl);
      Downloader.handleMWWarningsAndErrors(resp);

      let processedResponse = normalizeMwResponse(resp.query);

      gCont = resp['query-continue']?.allpages?.gapcontinue;

      const queryComplete = Object.keys(resp['query-continue'] || {})
        .filter((key) => key !== 'allpages')
        .length === 0;

      if (!queryComplete) {
        queryContinuation = resp['query-continue'];
        const relevantDetails = this.stripNonContinuedProps(processedResponse);
        result = result === undefined ? relevantDetails : deepmerge(result, relevantDetails);
      } else {
        if (this.mw.getCategories) {
          processedResponse = await this.setArticleSubCategories(processedResponse);
        }
        result = result === undefined ? processedResponse : deepmerge(result, processedResponse);
        break;
      }
    }

    return {
      articleDetails: this.mwRetToArticleDetail(result),
      gapContinue: gCont
    };
  }

  public async getArticle(articleId: string, dump: Dump, forceParsoidFallback: boolean = false): Promise<RenderedArticle[]> {
    articleId = articleId.replace(/ /g, '_');

    const isMainPage = articleId === dump.mwMetaData.mainPage;
    const articleApiUrl = this.getArticleUrl(articleId, isMainPage, forceParsoidFallback);

    logger.info(`Getting article [${articleId}] from ${articleApiUrl}`);

    try {
      const json = await this.getJSON<any>(articleApiUrl);
      if (json.type === 'api_error') {
        this.forceParsoidFallback = true;
        forceParsoidFallback = true;
        logger.error(`Received an "api_error", forcing all article requests to use Parsoid fallback`);
        throw new Error(`API Error when scraping [${articleApiUrl}]`);
      }
      return await renderArticle(json, articleId, dump, forceParsoidFallback);

    } catch (err) {
      if (forceParsoidFallback) throw err;
      if (err?.response?.status === 404) throw err;

      // falling back to local Parsoid
      const errMsg = err.response ? JSON.stringify(err.response.data, null, '\t') : err;
      logger.warn(`Failed to get article [${articleId}] using remote Parsoid, trying with local one`, errMsg);
      return await this.getArticle(articleId, dump, true);
    }
  }

  public async getJSON<T>(_url: string): Promise<T> {
    const self = this;
    const url = this.deserializeUrl(_url);
    await self.claimRequest();
    return new Promise<T>((resolve, reject) => {
      this.backoffCall(this.getJSONCb, {url, timeout: this.requestTimeout}, (err: any, val: any) => {
        self.releaseRequest();
        if (err) {
          const httpStatus = err.response && err.response.status;
          logger.warn(`Failed to get [${url}] [status=${httpStatus}]`);
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public async downloadContent(_url: string): Promise<{ content: Buffer | string, responseHeaders: any }> {
    if (!_url) {
      throw new Error(`Parameter [${_url}] is not a valid url`);
    }
    const url = this.deserializeUrl(_url);
    if (this.useDownloadCache) {
      try {
        const downloadCacheVal = await this.readFromDownloadCache(url);
        if (downloadCacheVal) {
          logger.info(`Download cache hit for [${url}]`);
          return downloadCacheVal;
        }
      } catch (err) {
        // NOOP (download cache miss)
      }
    }

    const self = this;
    await self.claimRequest();
    return new Promise((resolve, reject) => {
      const requestOptions = this.getRequestOptionsFromUrl(url);
      this.backoffCall(this.getContentCb, requestOptions, async (err: any, val: any) => {
        self.releaseRequest();
        if (err) {
          const httpStatus = err.response && err.response.status;
          logger.warn(`Failed to get [${url}] [status=${httpStatus}]`);
          reject(err);
        } else if (self.useDownloadCache && self.downloadCacheDirectory) {
          try {
            await self.writeToDownloadCache(url, val);
            resolve(val);
          } catch (err) {
            logger.warn(`Failed to cache download for [${url}]`, err);
            reject({ message: `Failed to cache download`, err });
          }
        } else {
          resolve(val);
        }
      });
    });
  }

  public async canGetUrl(url: string): Promise<boolean> {
    try {
      await axios.get(url);
      return true;
    } catch (err) {
      return false;
    }
  }

  private async writeToDownloadCache(url: string, val: { content: Buffer, responseHeaders: any }): Promise<void> {
    const fileName = md5(url);
    const filePath = path.join(this.downloadCacheDirectory, fileName);
    logger.info(`Caching response for [${url}] to [${filePath}]`);
    await writeFilePromise(filePath, val.content, null);
    await writeFilePromise(`${filePath}.headers`, JSON.stringify(val.responseHeaders), 'utf8');
  }

  private getArticleUrl(articleId: string, isMainPage: boolean, forceParsoidFallback: boolean): string {
    const useParsoidFallback = forceParsoidFallback || this.forceParsoidFallback || isMainPage;
    return useParsoidFallback || !this.mwCapabilities.mcsAvailable
      ? `${this.parsoidFallbackUrl}${encodeURIComponent(articleId)}`
      : `${this.mcsUrl}${encodeURIComponent(articleId)}`;
  }

  private async readFromDownloadCache(url: string) {
    if (!this.downloadCacheDirectory) {
      throw new Error('No Download Cache Directory Defined');
    }
    const fileName = md5(url);
    const filePath = path.join(this.downloadCacheDirectory, fileName);
    logger.info(`Finding cached donwload for [${url}] ([${filePath}])`);
    const [content, responseHeaders] = await Promise.all([
      readFilePromise(filePath, null),
      readFilePromise(`${filePath}.headers`, 'utf8').catch(() => null),
    ]);
    return {
      content, responseHeaders,
    };
  }

  private stripNonContinuedProps(articleDetails: QueryMwRet, cont: QueryContinueOpts | ContinueOpts = {}): QueryMwRet {
    const propsMap: KVS<string[]> = {
      pageimages: ['thumbnail', 'pageimage'],
      redirects: ['redirects'],
      coordinates: ['coordinates'],
      categories: ['categories'],
    };
    const keysToKeep: string[] = ['subCategories']
      .concat(
        Object.keys(cont).reduce((acc, key) => acc.concat(propsMap[key] || []), []),
      );
    const items = Object.entries(articleDetails)
      .map(([aId, detail]) => {
        const newDetail = keysToKeep
          .reduce((acc, key) => {
            const val = (detail as any)[key];
            if (!val) {
              return acc;
            } else {
              return {
                ...acc,
                [key]: val,
              };
            }
          }, {});
        return [
          aId,
          newDetail,
        ];
      });
    return items.reduce((acc, [key, detail]: any[]) => {
      return { ...acc, [key]: detail };
    }, {});
  }

  private static handleMWWarningsAndErrors(resp: MwApiResponse): void {
    if (resp.warnings) logger.warn(`Got warning from MW Query ${JSON.stringify(resp.warnings, null, '\t')}`);
    if (resp.error?.code === DB_ERROR) throw new Error(`Got error from MW Query ${JSON.stringify(resp.error, null, '\t')}`);
    if (resp.error) logger.log(`Got error from MW Query ${JSON.stringify(resp.warnings, null, '\t')}`);
  }

  private getArticleQueryOpts(includePageimages = false) {
    const validNamespaceIds = this.mw.namespacesToMirror.map((ns) => this.mw.namespaces[ns].num);
    return {
      action: 'query',
      format: 'json',
      prop: `redirects|revisions${includePageimages ? '|pageimages' : ''}${this.mwCapabilities.coordinatesAvailable ? '|coordinates' : ''}${this.mw.getCategories ? '|categories' : ''}`,
      rdlimit: 'max',
      rdnamespace: validNamespaceIds.join('|'),
    };
  }

  private async setArticleSubCategories(articleDetails: QueryMwRet) {
    logger.info(`Getting subCategories`);
    for (const [articleId, articleDetail] of Object.entries(articleDetails)) {
      const isCategoryArticle = articleDetail.ns === 14;
      if (isCategoryArticle) {
        const categoryMembers = await this.getSubCategories(articleId);
        (articleDetails[articleId] as any).subCategories = categoryMembers.slice();
      }
    }
    return articleDetails;
  }

  private getRequestOptionsFromUrl(url: string): AxiosRequestConfig {
    return {
      url,
      headers: {
        'accept': 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/1.8.0"',
        'cache-control': 'public, max-stale=86400',
        'accept-encoding': 'gzip, deflate',
        'user-agent': this.uaString,
        'cookie': this.loginCookie,
      },
      responseType: 'arraybuffer',
      timeout: this.requestTimeout,
      method: url.indexOf('action=login') > -1 ? 'POST' : 'GET',
    };
  }

  private async claimRequest(): Promise<null> {
    if (this.activeRequests < this.maxActiveRequests) {
      this.activeRequests += 1;
      return null;
    } else {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      return this.claimRequest();
    }
  }

  private async releaseRequest(): Promise<null> {
    this.activeRequests -= 1;
    return null;
  }

  private getJSONCb<T>({url, timeout}: AxiosRequestConfig, handler: (...args: any[]) => any): void {
    axios.get<T>(url, { responseType: 'json', timeout })
      .then((a) => handler(null, a.data), handler)
      .catch((err) => {
        try {
          if (err.response && err.response.status === 429) {
            logger.log(`Received a [status=429], slowing down`);
            const newMaxActiveRequests = Math.max(Math.ceil(this.maxActiveRequests * 0.9), 1);
            logger.log(`Setting maxActiveRequests from [${this.maxActiveRequests}] to [${newMaxActiveRequests}]`);
            this.maxActiveRequests = newMaxActiveRequests;
            return this.getJSONCb({url, timeout}, handler);
          } else if (err.response && err.response.status === 404) {
            handler(err);
          }
        } catch (a) {
          handler(err);
        }
      });
  }

  private async getCompressedBody(resp: any): Promise<any> {
    return this.isMimeTypeImage(resp.headers['content-type']) ? await imagemin.buffer(resp.data, imageminOptions) : resp.data;
  }

  private getContentCb = async (requestOptions: AxiosRequestConfig, handler: any): Promise<void> => {
    logger.info(`Downloading [${requestOptions.url}]`);

    try {
      if (this.optimisationCacheUrl && this.isImageUrl(requestOptions.url)) {
        this.s3.downloadIfPossible(this.stripHttpFromUrl(requestOptions.url), requestOptions.url).then(async (s3ImageResp) => {
          if (s3ImageResp) {
            handler(null, {
              responseHeaders: s3ImageResp.headers,
              content: s3ImageResp.imgData,
            });
          } else {
            await this.imageDownloadCompressAndUploadToS3(requestOptions, handler);
          }
        }).catch((err) => {
          this.errHandler(err, requestOptions, handler);
        });
      } else {
        const resp = await axios(requestOptions);
        handler(null, {
          responseHeaders: resp.headers,
          content: await this.getCompressedBody(resp),
        });
      }
    } catch (err) {
      try {
        this.errHandler(err, requestOptions, handler);
      } catch (a) {
        handler(err);
      }
    }
  }

  private errHandler(err: any, requestOptions: any, handler: any): void {
    if (err.response && err.response.status === 429) {
      logger.log(`Received a [status=429], slowing down`);
      const newMaxActiveRequests = Math.max(Math.ceil(this.maxActiveRequests * 0.9), 1);
      logger.log(`Setting maxActiveRequests from [${this.maxActiveRequests}] to [${newMaxActiveRequests}]`);
      this.maxActiveRequests = newMaxActiveRequests;
    }
    logger.log(`Not able to download content for ${requestOptions.url} due to ${err}`);
    handler(err);
  }

  private async imageDownloadCompressAndUploadToS3<T>(requestOptions: any, handler: any): Promise<void> {
    const resp = await axios(requestOptions);
    const etag = resp.headers.etag;
    const content = await this.getCompressedBody(resp);
    const compressionWorked = content.length < resp.data.length;
    if (compressionWorked) {
      resp.data = content;
    }

    if (etag) {
      this.s3.uploadBlob(this.stripHttpFromUrl(requestOptions.url), resp.data, etag);
    }

    handler(null, {
      responseHeaders: resp.headers,
      content: compressionWorked ? content : resp.data,
    });
  }

  private async getSubCategories(articleId: string, continueStr: string = ''): Promise<Array<{ pageid: number, ns: number, title: string }>> {
    const { query, continue: cont } = await this.getJSON<any>(this.mw.subCategoriesApiUrl(articleId, continueStr));
    const items = query.categorymembers.filter((a: any) => a && a.title);
    if (cont && cont.cmcontinue) {
      const nextItems = await this.getSubCategories(articleId, cont.cmcontinue);
      return items.concat(nextItems);
    } else {
      return items;
    }
  }

  private backoffCall(handler: (...args: any[]) => void, config: AxiosRequestConfig, callback: (...args: any[]) => void | Promise<void>): void {
    const call = backoff.call(handler, config, callback);
    call.setStrategy(this.backoffOptions.strategy);
    call.retryIf(this.backoffOptions.retryIf);
    call.failAfter(this.backoffOptions.failAfter);
    call.on('backoff', this.backoffOptions.backoffHandler);
    call.start();
  }

  public mwRetToArticleDetail(obj: QueryMwRet): KVS<ArticleDetail> {
    const result: KVS<ArticleDetail> = {};
    for (const [key, val] of Object.entries(obj)) {
      const rev = val.revisions && val.revisions[0];
      const geo = val.coordinates && val.coordinates[0];
      result[key] = {
        title: val.title,
        categories: val.categories,
        subCategories: val.subCategories,
        thumbnail: val.thumbnail ?? undefined,
        missing: val.missing,
        redirects: val.redirects,
        ...(val.ns !== 0 ? {ns: val.ns} : {}),
        ...(rev ? {revisionId: rev.revid, timestamp: rev.timestamp} : {}),
        ...(geo ? {coordinates: `${geo.lat};${geo.lon}`} : {})
      };
    }
    return result;
  }
}

export default Downloader;

import { RedisClient } from 'redis';
import { mapLimit } from 'promiso';

export class RedisKvs<T> {
    private redisClient: RedisClient;
    private dbName: string;

    private scanCursor = '0';
    private pendingScan: Promise<{ cursor: string, items: Array<[string, string]> }> = Promise.resolve({} as any);

    constructor(redisClient: RedisClient, dbName: string) {
        this.redisClient = redisClient;
        this.dbName = dbName;
    }

    public get(prop: string) {
        return new Promise<T>((resolve, reject) => {
            this.redisClient.hget(this.dbName, prop, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(JSON.parse(val));
                }
            });
        });
    }

    public getMany(prop: string[]) {
        return new Promise<T[]>((resolve, reject) => {
            this.redisClient.hmget(this.dbName, prop, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val.map((a) => JSON.parse(a)));
                }
            });
        });
    }

    public set(prop: string, val: T) {
        return new Promise((resolve, reject) => {
            const normalisedVal = typeof val !== 'string' ? JSON.stringify(val) : val;
            this.redisClient.hset(this.dbName, prop, normalisedVal as string, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public setMany(val: KVS<T>) {
        return new Promise((resolve, reject) => {
            const numKeys = Object.keys(val).length;
            if (!numKeys) {
                resolve();
                return;
            }
            const normalisedVal = Object.entries(val)
                .reduce((acc: KVS<string>, [key, val]) => {
                    acc[key] = typeof val !== 'string' ? JSON.stringify(val) : val;
                    return acc;
                }, {});
            this.redisClient.hmset(this.dbName, normalisedVal as string, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public delete(prop: string) {
        return new Promise((resolve, reject) => {
            this.redisClient.hdel(this.dbName, prop, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public keys() {
        return new Promise<string[]>((resolve, reject) => {
            this.redisClient.hkeys(this.dbName, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public len() {
        return new Promise<number>((resolve, reject) => {
            this.redisClient.hlen(this.dbName, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public async iterateItems(numWorkers: number, func: (items: Array<[string, T]>, workerId: number) => Promise<void>) {
        let hasLooped = false;

        const workers = ','.repeat(numWorkers - 1).split(',').map((_, i) => i);
        await mapLimit(
            workers,
            numWorkers,
            async (workerId) => {
                while (true) {
                    const { cursor, items } = await this.scan();

                    if (hasLooped) { // Must be after the await
                        return;
                    }

                    if (cursor === '0') {
                        hasLooped = true;
                    }

                    const parsedItems: Array<[string, T]> = items.map(([key, strVal]) => [key, JSON.parse(strVal)]);

                    await func(parsedItems, workerId);
                }
            },
        );
    }

    public scan() {
        const retPromise = this.pendingScan.then(() => {
            return new Promise<{ cursor: string, items: Array<[string, string]> }>((resolve, reject) => {
                this.redisClient.hscan(this.dbName, this.scanCursor, (err, val) => {
                    if (err) {
                        reject(err);
                    } else {
                        this.scanCursor = val[0];
                        const items = val[1].reduce((acc, item, index, arr) => {
                            if (index % 2 === 0) {
                                acc.push([item, arr[index + 1]]);
                                return acc;
                            } else {
                                return acc;
                            }
                        }, []);
                        resolve({
                            cursor: val[0],
                            items,
                        });
                    }
                });
            });
        });
        this.pendingScan = retPromise;
        return retPromise;
    }

    public flush() {
        return new Promise<void>((resolve, reject) => {
            this.redisClient.del(this.dbName, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}

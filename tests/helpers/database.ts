import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ApiEnv } from '../../lib/server.ts';

// Execute the actual SQL against SQLite, matching D1's prepared-statement API.
export class TestDatabase {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) {
    const sqlite = this.sqlite;
    return { bind(...args: unknown[]) {
      const values = args as SQLInputValue[];
      return {
        async first<T>():Promise<T | null> { return (sqlite.prepare(sql).get(...values) as T) ?? null; },
        async all<T>() { return {results:sqlite.prepare(sql).all(...values) as T[]}; },
        async run() { return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}; },
      };
    }};
  }
  count(table: 'projects' | 'assets' | 'auth_users' | 'auth_sessions') {
    return Number(this.sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  }
}

export function testEnvironment() {
  const db = new TestDatabase();
  const objects = new Map<string, Uint8Array>();
  const env:ApiEnv = { DB:db, ASSETS_BUCKET:{
    put:async (key, body) => { objects.set(key,new Uint8Array(body)); },
    head:async key => { const bytes=objects.get(key); return bytes ? {size:bytes.byteLength} : null; },
    get:async (key,options) => {
      const bytes=objects.get(key);
      if (!bytes) return null;
      const body=options?.range ? bytes.slice(options.range.offset,options.range.offset+options.range.length) : bytes;
      return {body:new ReadableStream({start(c) { c.enqueue(body); c.close(); }}),arrayBuffer:async()=>new Uint8Array(body).buffer};
    },
  }};
  return {db,objects,env};
}

export function apiRequest(path:string, method='GET', body?:unknown, cookie='', origin='https://studio.example') {
  return new Request(`${origin}${path}`,{method,headers:{cookie,...(body ? {'content-type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
}

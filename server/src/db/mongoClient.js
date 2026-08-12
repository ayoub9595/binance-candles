import { MongoClient } from 'mongodb';
import { config } from '../config.js';

let client;
let db;

export async function connectMongo() {
  client = new MongoClient(config.mongodbUri);
  await client.connect();
  db = client.db(config.dbName);

  await db.collection('candles').createIndex(
    { symbol: 1, interval: 1, openTime: 1 },
    { unique: true }
  );

  return db;
}

export function getCollection(name) {
  if (!db) throw new Error('Mongo not connected yet — call connectMongo() first');
  return db.collection(name);
}

export async function closeMongo() {
  if (client) await client.close();
}

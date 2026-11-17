import 'dotenv/config';
import { readConfig } from '../server/config';
import { Store } from '../server/store';
const store = new Store(readConfig().dataDir); store.close();
console.log('The library database is up to date.');

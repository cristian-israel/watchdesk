'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('dotenv');

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];

const envFile = candidates.find((p) => fs.existsSync(p));
if (envFile) {
  config({ path: envFile });
}

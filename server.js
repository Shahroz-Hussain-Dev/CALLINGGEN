'use strict';
require('dotenv').config();
const app = require('./server/app');
const config = require('./server/config');
const logger = require('./server/logger');

app.listen(config.port, () => {
  logger.info(`${config.app.name} listening`, { port: config.port, env: config.env });
});

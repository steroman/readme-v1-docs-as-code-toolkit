// scripts/sync/api-client.js

const axios = require('axios');
const { CONFIG, DRY_RUN } = require('./config.js');

const authHeader = `Basic ${Buffer.from(`${CONFIG.README_API_KEY}:`).toString('base64')}`;

async function throttledApiCall(method, endpoint, payload = null, headers = {}) {
  const normalizedMethod = method.toLowerCase();
  const isWriteOperation = ['post', 'put', 'delete'].includes(normalizedMethod);

  if (DRY_RUN && isWriteOperation) {
    console.log(`[DRY-RUN] ${normalizedMethod.toUpperCase()} ${endpoint}`);
    return { data: null, status: normalizedMethod === 'post' ? 201 : 200 };
  }

  await new Promise((resolve) => setTimeout(resolve, CONFIG.API_CALL_DELAY_MS));

  const isBodylessRequest = ['get', 'delete'].includes(normalizedMethod);
  const baseURL = (CONFIG.README_BASE_URL || 'https://dash.readme.com/api/v1').replace(/\/$/, '');
  const url = `${baseURL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const config = {
    method: normalizedMethod,
    url,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      ...headers,
    },
    data: isBodylessRequest ? null : payload,
    params: isBodylessRequest ? payload : null,
    timeout: 30000,
  };

  if (isBodylessRequest) {
    config.headers['Content-Type'] = 'text/plain';
  } else {
    config.headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await axios(config);
    return res;
  } catch (e) {
    if (e.response) {
      if (e.response.status === 404 && normalizedMethod === 'delete') {
        return { data: e.response.data, status: 404 };
      }
      throw new Error(`API Error ${e.response.status} on ${method} ${url}: ${JSON.stringify(e.response.data)}`);
    }
    throw e;
  }
}

exports.throttledApiCall = throttledApiCall;
import { RequestOptions, IncomingMessage, IncomingHttpHeaders } from 'http';
import https from 'https';

interface RetryConfig {
  maxRetries: number;
  delayMs: number;
  exponentialBackoff?: boolean;
  retryStatusCodes?: number[];
}

interface HttpResponse<T = any> {
  data: T;
  status: number;
  headers: IncomingHttpHeaders;
}

interface HttpError<T = any> {
  status: number;
  data: T;
  headers: IncomingHttpHeaders;
}

interface RequestConfig extends Omit<RequestOptions, 'body'> {
  body?: Record<string, any> | string;
  retry?: RetryConfig;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  delayMs: 1000,
  exponentialBackoff: true,
  retryStatusCodes: [408, 429, 500, 502, 503, 504]
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequestWithRetry<T = any>(
  url: string,
  options: RequestConfig = {},
  currentAttempt = 1
): Promise<HttpResponse<T>> {
  const retryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.retry
  };

  try {
    return await makeRequest<T>(url, options);
  } catch (error) {
    const shouldRetry = error instanceof Object &&
      'status' in error &&
      retryConfig.retryStatusCodes?.includes(error.status as number) &&
      currentAttempt < retryConfig.maxRetries;

    if (!shouldRetry) {
      throw error;
    }

    const delayMs = retryConfig.exponentialBackoff
      ? retryConfig.delayMs * Math.pow(2, currentAttempt - 1)
      : retryConfig.delayMs;

    await sleep(delayMs);
    return makeRequestWithRetry<T>(url, options, currentAttempt + 1);
  }
}

function makeRequest<T = any>(url: string, options: RequestConfig = {}): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: IncomingMessage) => {
      let data = '';

      res.on('data', (chunk: Buffer) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const contentType = res.headers['content-type'];
          const response = contentType?.includes('application/json')
            ? JSON.parse(data)
            : data;

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              data: response,
              status: res.statusCode,
              headers: res.headers
            });
          } else {
            reject({
              status: res.statusCode,
              data: response,
              headers: res.headers
            } as HttpError<T>);
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error: Error) => {
      reject(error);
    });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }

    req.end();
  });
}

class HttpClient {
  private defaultRetryConfig?: RetryConfig;

  constructor(defaultRetryConfig?: RetryConfig) {
    this.defaultRetryConfig = defaultRetryConfig;
  }

  async get<T = any>(
    url: string,
    headers: Record<string, string> = {},
    retry?: RetryConfig
  ): Promise<HttpResponse<T>> {
    return makeRequestWithRetry<T>(url, {
      method: 'GET',
      headers,
      retry: retry || this.defaultRetryConfig
    });
  }

  async post<T = any>(
    url: string,
    body: Record<string, any>,
    headers: Record<string, string> = {},
    retry?: RetryConfig
  ): Promise<HttpResponse<T>> {
    return makeRequestWithRetry<T>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body,
      retry: retry || this.defaultRetryConfig
    });
  }

  async put<T = any>(
    url: string,
    body: Record<string, any>,
    headers: Record<string, string> = {},
    retry?: RetryConfig
  ): Promise<HttpResponse<T>> {
    return makeRequestWithRetry<T>(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body,
      retry: retry || this.defaultRetryConfig
    });
  }

  async delete<T = any>(
    url: string,
    headers: Record<string, string> = {},
    retry?: RetryConfig
  ): Promise<HttpResponse<T>> {
    return makeRequestWithRetry<T>(url, {
      method: 'DELETE',
      headers,
      retry: retry || this.defaultRetryConfig
    });
  }
}

export const httpClient = new HttpClient();
export default httpClient;
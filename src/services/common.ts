import { NetworkError, ServiceError } from "../errors";

const LIB_VERSION = require('../../package.json').version;

export interface IZkBobService {
  type(): ServiceType;
  url(): string;  // current usable service URL
  version(): Promise<ServiceVersion>;
  healthcheck(): Promise<boolean>;  // returns true when service is healthy
}

export enum ServiceType {
    Relayer = "Relayer",
    Proxy = "Proxy",
    DelegatedProver = "Delegated Prover"
}

// ServiceVersion consist of name and git commitment hash
export interface ServiceVersion {
  ref: string;
  commitHash: string;
}
export const isServiceVersion = (obj: any): obj is ServiceVersion => {
  return typeof obj === 'object' && obj !== null &&
    obj.hasOwnProperty('ref') && typeof obj.ref === 'string' &&
    obj.hasOwnProperty('commitHash') && typeof obj.commitHash === 'string';
}

// ServiceVersion + fetching timestamp
export interface ServiceVersionFetch {
  version: ServiceVersion;
  timestamp: number;  // when the version was fetched
}

// Get request default headers for ZkBob services with optional support ID
export function defaultHeaders(supportId?: string): Record<string, string> {
  if (supportId) {
    return {'content-type': 'application/json;charset=UTF-8',
            'zkbob-libjs-version': LIB_VERSION,
            'zkbob-support-id': supportId};
  }

  return {'content-type': 'application/json;charset=UTF-8',
          'zkbob-libjs-version': LIB_VERSION};
}

// Universal ZkBob service response parser
export async function fetchJson(url: string, headers: RequestInit, service: ServiceType): Promise<any> {
    let response: Response;
    try {
      response = await fetch(url, headers);
    } catch(err) {
      // server is unreachable
      throw new NetworkError(err, url);
    }

    // Extract response body: json | string | null
    let responseBody: any = null;
    const contentType = response.headers.get('content-type')!;
    if (contentType === null) responseBody = null;
    else if (contentType.startsWith('application/json')) responseBody = await response.json();
    else if (contentType.startsWith('text/plain')) responseBody = await response.text();
    else if (contentType.startsWith('text/html')) responseBody = (await response.text()).replace(/<[^>]+>/g, '').replace(/(?:\r\n|\r|\n)/g, ' ').replace(/^\s+|\s+$/gm,'');
    else console.warn(`Unsupported response content-type in response: ${contentType}`);

    // Unsuccess error code case (not in range 200-299)
    if (!response.ok) {
      if (responseBody === null) {
        throw new ServiceError(service, response.status, 'no description provided');  
      }

      // process string error response
      if (typeof responseBody === 'string') {
        throw new ServiceError(service, response.status, responseBody);
      }

      // process multiple errors json response
      if (Array.isArray(responseBody.errors) || Array.isArray(responseBody)) {
        const errArr = Array.isArray(responseBody.errors) ? responseBody.errors : responseBody;
        const errorsText = errArr.map((oneError) => {
          return `${oneError.path ? `[${oneError.path}]: ` : ''}${oneError.message}`;
        }).join(', ');

        throw new ServiceError(service, response.status, errorsText);
      }

      // unknown error format
      throw new ServiceError(service, response.status, contentType);
    } 

    return responseBody;
  }
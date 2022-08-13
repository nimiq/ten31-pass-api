// Similar in spirit to Nimiq Hub's request behaviors but different in implementation because the Hub's request
// behaviors are based on @nimiq/rpc which TEN31 Pass does not use.

import { postRequest } from './utils';

// Only for internal use. To the outside, we throw errors.
export enum ResponseStatus {
    Success = 'Success',
    Error = 'Error',
    InvalidRequest = 'InvalidRequest',
    Unknown = 'Unknown',
}

export class RedirectBehavior {
    static getRecoverableState(requestId: string): any {
        return JSON.parse(window.sessionStorage[RedirectBehavior.STORAGE_KEY] || '{}')[requestId] || null;
    }

    static setRecoverableState(requestId: string, recoverableState: any): void {
        window.sessionStorage[RedirectBehavior.STORAGE_KEY] = JSON.stringify({
            ...JSON.parse(window.sessionStorage[RedirectBehavior.STORAGE_KEY] || '{}'),
            [requestId]: recoverableState,
        });
    }

    static getRedirectResponse(
        event: string,
        requiredKeys: Array<string | RegExp> = [], // Status always required, others only for status !== 'Success'
        optionalKeys: Array<string | RegExp> = [],
        origin?: string,
    ): Record<string, string> | null {
        if (origin && (!document.referrer || new URL(document.referrer).origin !== origin)) return null;

        if (!requiredKeys.includes('status')) {
            requiredKeys.push('status');
        }
        const responseId = event
            + `_required:${requiredKeys.map((key) => key.toString()).sort()}`
            + (optionalKeys.length ? `_optional:${optionalKeys.map((key) => key.toString()).sort()}` : '');

        // Try to find response in location.search or location.hash
        for (let query of [location.search, location.hash]) {
            query = query.substring(1); // remove query ? or fragment #
            if (!query) continue;
            const parsedQuery = new URLSearchParams(query);
            if (parsedQuery.get('event') !== event) continue;

            // Cleaned up query where we'll remove the redirect response but leave all other potential parameters as
            // they are by using string replacements instead of parsedQuery.delete and then parsedQuery.toString to
            // avoid format changes of remaining parameters.
            let cleanedQuery = query.replace(/event=[^&]+&?/, '');

            // Read required and optional values
            const response: Record<string, string> = {};
            const expectedKeys = [...requiredKeys, ...optionalKeys];
            const missingRequiredKeys: Set<string | RegExp> = new Set(requiredKeys);
            for (const [key, value] of parsedQuery) {
                for (const expectedKey of expectedKeys) {
                    if (typeof expectedKey === 'string' ? expectedKey !== key : key.match(expectedKey)?.[0] !== key) {
                        continue;
                    }
                    response[key] = value;
                    missingRequiredKeys.delete(expectedKey);
                    // Remove the entry from the cleaned query
                    cleanedQuery = cleanedQuery.replace(new RegExp(
                        // Turn string into regex by escaping regex special chars.
                        `${key}=${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        // Remove & between this and the following entry
                        + '&?'
                    ), '');
                    break;
                }
            }
            cleanedQuery = cleanedQuery.replace(/&$/, ''); // remove potential leftover trailing &

            if (!response.status || (response.status === ResponseStatus.Success && missingRequiredKeys.size)) {
                throw new Error('TEN31 Pass did not return expected response.');
            }
            if (response.status !== ResponseStatus.Success) {
                // Different to popup requests, reject on any kind of error because the user can not retry anymore after
                // the redirect. With the current TEN31 Pass implementation however, redirects are only executed for
                // successful requests anyways.
                throw new Error(`TEN31 Pass rejected request with error: ${response.status}`, {
                    cause: new Error(response.status),
                });
            }

            // Cache response and set new url with removed redirect response
            history.replaceState(
                {
                    ...history.state,
                    [RedirectBehavior.STORAGE_KEY]: {
                        ...history.state?.[RedirectBehavior.STORAGE_KEY],
                        [responseId]: response,
                    },
                },
                '',
                location.href.replace(query, cleanedQuery),
            );

            return response;
        }

        // Check for cached response
        return history.state?.[RedirectBehavior.STORAGE_KEY]?.[responseId] || null;
    }

    private static readonly STORAGE_KEY = 'ten31-pass-redirect-behavior';

    constructor(private endpoint: string) {}

    call(request: string, data?: Record<string, unknown>, options?: RedirectBehavior.RequestOptions): void {
        if (options && 'recoverableState' in options) {
            RedirectBehavior.setRecoverableState(options.requestId, options.recoverableState);
        }
        const url = `${this.endpoint}${request}`;
        if (data) {
            postRequest(url, data, false);
        } else {
            window.location.assign(url);
        }
    }
}

namespace RedirectBehavior {
    export type RequestOptions = {} | {
        requestId: string,
        recoverableState: any,
    };
}

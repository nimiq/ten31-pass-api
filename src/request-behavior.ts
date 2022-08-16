// Similar in spirit to Nimiq Hub's request behaviors but different in implementation because the Hub's request
// behaviors are based on @nimiq/rpc which TEN31 Pass does not use.

import { generateWindowName, postRequest } from './utils';

export enum ResponseType {
    POST_MESSAGE = 'post-message',
    REDIRECT = 'redirect',
    IMMEDIATE_REDIRECT = 'immediate-redirect', // automatically and immediately redirect without showing success page
}

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
        requiredKeys: Array<string | RegExp> = [], // status always required, others only for status === 'Success'
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
        if (data || options?.preferredResponseType) {
            postRequest(url, {
                ...data,
                ...(options?.preferredResponseType ? { preferred_response_type: options.preferredResponseType } : null),
            });
        } else {
            window.location.assign(url);
        }
    }
}

namespace RedirectBehavior {
    export type RequestOptions = {
        // The default is ResponseType.REDIRECT.
        // Usage of ResponseType.POST_MESSAGE even for redirect requests is theoretically possible if the calling page
        // itself is already a popup, but this is currently not encouraged by the api and the postMessage response would
        // needed to be checked manually by the page that opened the popup.
        preferredResponseType?: Exclude<ResponseType, ResponseType.POST_MESSAGE>,
    } & RecoverStateOptions;

    export type RecoverStateOptions = {} | {
        requestId: string,
        recoverableState: any,
    };
}

export class PopupBehavior {
    private static createPopup(url: string): WindowProxy {
        const popupName = generateWindowName(url);
        const popup = window.open(
            url,
            popupName,
            `left=${window.innerWidth / 2 - 400},top=75,width=800,height=850,location=yes`,
        );
        if (!popup) throw new Error('TEN31 Pass popup failed to open.');
        return popup;
    }

    private readonly _endpointOrigin: string;

    constructor(private endpoint: string) {
        this._endpointOrigin = new URL(this.endpoint).origin;
    }

    call(
        request: string,
        data?: Record<string, unknown>,
        options?: Exclude<PopupBehavior.RequestOptions<never>, { preferredResponseType: ResponseType.POST_MESSAGE }>,
    ): void; // call without expecting a response (the default)
    call<T extends object>(
        request: string,
        data: Record<string, unknown> | undefined,
        options: Extract<PopupBehavior.RequestOptions<T>, { preferredResponseType: ResponseType.POST_MESSAGE }>,
    ): Promise<T>; // call expecting a response via post message
    call<T extends object>(
        request: string,
        data: Record<string, unknown> | undefined,
        options?: PopupBehavior.RequestOptions<T>,
    ): Promise<T> | void {
        if (options && 'recoverableState' in options) {
            // Cache recoverable state if requested, regardless of popup and preferred response type because also popups
            // can respond via redirect if requested or as a fallback if no Javascript is available on TEN31 Pass.
            RedirectBehavior.setRecoverableState(options.requestId, options.recoverableState);
        }

        const url = `${this.endpoint}${request}`;
        const popup = PopupBehavior.createPopup(url);
        if (data || options?.preferredResponseType) {
            postRequest(url, {
                ...data,
                ...(options?.preferredResponseType ? { preferred_response_type: options.preferredResponseType } : null),
            }, popup);
        }

        if (options?.preferredResponseType !== ResponseType.POST_MESSAGE) {
            // not expecting a response
            return;
        }

        return new Promise<T>((resolve, reject) => {
            let closeCheckInterval = -1;
            const onPopupMessage = (event: MessageEvent<unknown>) => {
                if (event.origin !== this._endpointOrigin || !event.data || typeof event.data !== 'object'
                    || (event.data as any).event !== options.responseEvent) return;
                delete (event.data as any).event;
                const responseMessage = event.data as PopupBehavior.ResponseMessage<T>;
                if (options.responseFilter
                    ? !options.responseFilter(responseMessage)
                    // By default ignore unspecified errors (e.g. got logged out or wrong totp) as user can try again.
                    : [ResponseStatus.Error, ResponseStatus.Unknown].includes(responseMessage.status)) {
                    return;
                }
                window.removeEventListener('message', onPopupMessage);
                window.clearInterval(closeCheckInterval);

                if (!responseMessage.status
                    || (responseMessage.status === ResponseStatus.Success && options.requiredKeys
                        && options.requiredKeys.some((requiredKey) => typeof requiredKey === 'string'
                            ? !(requiredKey in responseMessage)
                            : !Object.keys(responseMessage).some((key) => key.match(requiredKey)?.[0] === key
                )))) {
                    reject(new Error('TEN31 Pass did not return expected response.'));
                } else if (responseMessage.status !== ResponseStatus.Success) {
                    reject(new Error(`TEN31 Pass rejected request with error: ${responseMessage.status}`, {
                        cause: new Error(responseMessage.status),
                    }));
                } else {
                    // only expose expected properties
                    delete (responseMessage as Partial<typeof responseMessage>).status;
                    resolve(responseMessage);
                }
            };

            window.addEventListener('message', onPopupMessage);
            closeCheckInterval = window.setInterval(() => {
                if (!popup.closed) return;
                window.removeEventListener('message', onPopupMessage);
                window.clearInterval(closeCheckInterval);
                reject(new Error('TEN31 Pass popup closed'));
            }, 300);
        });
    }
}

namespace PopupBehavior {
    export type RequestOptions<T extends object> = ({
        // not expecting a response (the default) either because there is none or we expect it as redirect response
        preferredResponseType?: Exclude<ResponseType, ResponseType.POST_MESSAGE>,
    } | {
        preferredResponseType: ResponseType.POST_MESSAGE,
        responseEvent: string,
        responseFilter?: (responseMessage: ResponseMessage<T>) => boolean,
        requiredKeys?: Array<string | RegExp>, // status always required, others only for status === 'Success'
    }) & RedirectBehavior.RecoverStateOptions;

    export type ResponseMessage<T extends object> = (T & { status: ResponseStatus.Success })
        | { status: Exclude<ResponseStatus, ResponseStatus.Success> };
}

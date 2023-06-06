// Similar in spirit to Nimiq Hub's request behaviors but different in implementation because the Hub's request
// behaviors are based on @nimiq/rpc which TEN31 Pass does not use.

import { generateWindowName, postRequest, isIOS } from './utils';

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

class RedirectBehavior {
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

class PopupBehavior {
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

        const requestUrl = `${this.endpoint}${request}`;
        const requestData = data || options?.preferredResponseType ? {
            ...data,
            ...(options?.preferredResponseType ? { preferred_response_type: options.preferredResponseType } : null),
        } : undefined;

        // Throws if popup fails to open. Note that the overlay is only appended later, if the popup could be opened.
        let popup: WindowProxy = PopupBehavior.createPopup(requestUrl);
        if (requestData) {
            postRequest(requestUrl, requestData, popup);
        }

        let overlay: HTMLDivElement | undefined;
        const overlayOptions: Parameters<this['appendPopupOverlay']>[2] = typeof options?.overlay === 'object'
            ? options.overlay
            : {};
        if (options?.overlay) {
            overlay = this.appendPopupOverlay(
                /* onFocusRequested */ () => {
                    if (isIOS()) {
                        // iOS doesn't allow to focus the popup. We have to re-open it to bring it to the front.
                        // We don't have to unregister our close check and post message listener because they
                        // automatically work on the new popup.
                        popup.close();
                        // Note that we don't need to explicitly handle the popup failing to open: the request will be
                        // rejected via closeCheckInterval by the old popup being closed, after which then also the
                        // overlay gets removed, or it's directly removed by closeCheckInterval for the case that no
                        // response is expected.
                        popup = PopupBehavior.createPopup(requestUrl);
                        if (requestData) {
                            postRequest(requestUrl, requestData, popup);
                        }
                    } else {
                        popup.focus();
                    }
                },
                /* onCloseRequested */ () => popup.close(),
                overlayOptions,
            );
        }

        if (options?.preferredResponseType !== ResponseType.POST_MESSAGE) {
            // not expecting a response
            if (overlay) {
                // Remove overlay again once the popup has been closed
                const closeCheckInterval = window.setInterval(() => {
                    if (!popup.closed) return;
                    window.clearInterval(closeCheckInterval);
                    this.removeOverlay(overlay!);
                }, 300);
            }
            return;
        }

        let closeCheckInterval = -1;
        let onPopupMessage: (event: MessageEvent<unknown>) => void;
        return new Promise<T>((resolve, reject) => {
            onPopupMessage = (event: MessageEvent<unknown>) => {
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
                reject(new Error('TEN31 Pass popup closed'));
            }, 300);
            overlayOptions.onCallbackError = reject;
        }).finally(() => {
            window.removeEventListener('message', onPopupMessage);
            window.clearInterval(closeCheckInterval);
            if (!overlay) return;
            this.removeOverlay(overlay);
        });
    }

    appendPopupOverlay(
        onFocusRequested: () => void,
        onCloseRequested: () => void,
        overlayOptions?: Exclude<PopupBehavior.OverlayOptions['overlay'], boolean> & {
            onCallbackError?: (e: Error) => void,
        },
    ): HTMLDivElement {
        // Similar to Nimiq Hub's PopupRequestBehavior

        // Define DOM-method abstractions to allow better minification
        const createElement = document.createElement.bind(document);
        const appendChild = (node: Node, child: Node) => node.appendChild(child);

        // Overlay background
        const overlay = createElement('div');
        overlay.id = 'ten31-pass-overlay'; // styles can be overwritten with css targeting this id
        const overlayStyle = overlay.style;
        overlayStyle.position = 'fixed';
        overlayStyle.top = '0';
        overlayStyle.right = '0';
        overlayStyle.bottom = '0';
        overlayStyle.left = '0';
        overlayStyle.background = 'rgba(31, 35, 72, 0.8)';
        overlayStyle.display = 'flex';
        overlayStyle.flexDirection = 'column';
        overlayStyle.alignItems = 'center';
        overlayStyle.justifyContent = 'space-between';
        overlayStyle.cursor = 'pointer';
        overlayStyle.color = 'white';
        overlayStyle.textAlign = 'center';
        overlayStyle.opacity = '0';
        overlayStyle.transition = 'opacity .6s ease';
        overlayStyle.zIndex = '99999';
        overlay.addEventListener('click', () => {
            try {
                onFocusRequested();
            } catch (e: any) {
                if (!overlayOptions?.onCallbackError) throw e;
                overlayOptions.onCallbackError(e);
            }
        });

        // Top flex spacer
        appendChild(overlay, createElement('div'));

        // Explainer text
        const text = createElement('div');
        text.className = 'text';
        text.textContent = overlayOptions?.text
            || 'A popup has been opened,\nclick anywhere to bring it back to the front.';
        const textStyle = text.style;
        textStyle.padding = '20px';
        textStyle.fontFamily = 'Muli, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, '
            + 'Cantarell, "Helvetica Neue", sans-serif';
        textStyle.fontSize = '24px';
        textStyle.fontWeight = '600';
        textStyle.lineHeight = '40px';
        textStyle.whiteSpace = 'pre-line';
        appendChild(overlay, text);

        // Logo
        const logo = createElement('img');
        logo.className = 'logo';
        logo.src = overlayOptions?.logo
            || 'data:image/svg+xml,<svg width="150" height="30" viewBox="0 0 75 15" xmlns="http://www.w3.org/2000/svg"><path d="M1 .5H12v2.8H8v11.2H5.1V3.3H1V.5Zm21.5 0H14v14h8.4v-2.8h-5.6V8.9H21V6.1h-4.2V3.3h5.6V.5Zm46.1 0v2.8L66.8.5h-.9v4.2h.9V1.9l1.8 2.8h.8V.5h-.8Zm-5.1 0L65 4.7h-.9l-.3-.8H62l-.3.8H61L62.5.5h1Zm0 2.6L63 1.6l-.6 1.5h1.2Zm-3.3.5a1.1 1.1 0 0 1-1.1 1.1h-2V.5h1.7a1.1 1.1 0 0 1 .7 2 1.1 1.1 0 0 1 .7 1ZM58 2.2h.5a.6.6 0 0 0 .4-1 .6.6 0 0 0-.4 0H58v1Zm1.4 1.3a.6.6 0 0 0-.6-.6H58V4h.8a.6.6 0 0 0 .6-.6ZM74 .5H73L71.5 2V.5h-.8v4.2h.8V3.2l.4-.4L73 4.7h1l-1.6-2.5L74 .5ZM46 5.3 48.8.5h-9.6v2.8H44l-2.6 4.2h2.1c1.3 0 2.3 1 2.3 2.1 0 1.2-1 2.1-2.3 2.1-1 0-2.4-.6-3.5-1.8l-1.5 2.5a7.3 7.3 0 0 0 5 2.1 5 5 0 0 0 5-4.9A4.9 4.9 0 0 0 46 5.3ZM51.1.5l-1.7 2.8h2V12l2.8-4.7V.5h-3.1ZM32.4.5v8.6L27.2.5h-2.8v14h2.8V5.9l5.2 8.6h2.8V.5h-2.8Z" fill="white"/></svg>';
        logo.style.marginBottom = '56px';
        appendChild(overlay, logo);

        // Close button
        const button = createElement('div');
        button.className = 'close';
        const buttonStyle = button.style;
        button.innerHTML = '&times;';
        buttonStyle.position = 'absolute';
        buttonStyle.top = '8px';
        buttonStyle.right = '8px';
        buttonStyle.fontSize = '24px';
        buttonStyle.lineHeight = '32px';
        buttonStyle.fontWeight = '600';
        buttonStyle.width = '32px';
        buttonStyle.height = '32px';
        buttonStyle.opacity = '0.8';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                onCloseRequested();
            } catch (e: any) {
                if (!overlayOptions?.onCallbackError) throw e;
                overlayOptions.onCallbackError(e);
            }
        });
        appendChild(overlay, button);

        // The 100ms delay is not just because the DOM element needs to be rendered before it
        // can be animated, but also because it actually feels better when there is a short
        // delay between the opening popup and the background fading.
        setTimeout(() => overlay.style.opacity = '1', 100);

        return appendChild(document.body, overlay) as HTMLDivElement;
    }

    private removeOverlay(overlay: HTMLDivElement): void {
        overlay.style.opacity = '0';
        setTimeout(() => document.body.removeChild(overlay), 400);
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
    }) & OverlayOptions & RedirectBehavior.RecoverStateOptions;

    export interface OverlayOptions {
        overlay?: boolean | {
            text?: string,
            logo?: string,
        },
    }

    export type ResponseMessage<T extends object> = (T & { status: ResponseStatus.Success })
        | { status: Exclude<ResponseStatus, ResponseStatus.Success> };
}

export { RedirectBehavior, PopupBehavior };

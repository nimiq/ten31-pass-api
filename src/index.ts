import { RedirectBehavior, PopupBehavior, ResponseType } from './request-behavior';

export { ResponseType };

export enum Endpoint {
    MAIN = 'https://pass.ten31.com/',
    TEST = 'https://test.pass.ten31.com/',
    LOCAL = 'http://localhost:8082/',
}

export type UsageParameters = Record<string, unknown>;

export interface ServiceRequest {
    serviceId: string,
    usages?: Array<{
        usageId: string,
        parameters?: UsageParameters,
    }>,
}

export interface GrantResponse {
    /** App grant */
    app: string,
    /**
     * Map of service id -> service grant. Empty object if no service grants were requested / given.
     * Service usage grants are not included here. They can be fetched via getServiceGrantInfo if needed.
     */
    services: Record<string, string>,
}

export interface AppInfo {
    id: string,
    displayName: string,
    /** Whether TEN31 Pass provides a logo for this app */
    hasLogo: boolean,
    /** The url where to redirect after redirect requests */
    redirect: string,
    /** Whether to encode the redirect result in the url fragment or search query */
    fragment: boolean,
}

export interface ServiceInfo {
    id: string,
    displayName: string,
    /** Whether TEN31 Pass provides a logo for this service */
    hasLogo: boolean,
    usages: Record</* service usage id */ string, ServiceUsageInfo>
}

export interface ServiceUsageInfo {
    id: string,
    displayName: string,
    /** Whether TEN31 Pass provides a logo for this service usage */
    hasLogo: boolean,
    /** A description, which can optionally contain placeholders for usage parameters */
    description?: string | null,
    /** Names of expected usage parameters */
    fields: string[],
}

export interface AppGrantInfo {
    id: string,
    /** Date string encoding the first usage time */
    timestamp: string,
    app: AppInfo,
    // note: user is nullable in AppGrantInfo type in the TEN31 Pass code but ensured to be set by getAppGrantInfo
    user: UserInfo,
}

export interface UserInfo {
    id: string,
    email: string,
    /** User's name */
    // note: Can also be the email address until name was provided during signup, however for us here it's always the
    // user's name as grants can only be given after signup was completed.
    displayName: string,
    /** Latest identification for latest user identity if not expired, or an empty list otherwise */
    // note: By type in TEN31 Pass theoretically a list of all of the user's identifications, however what we're getting
    // here via api by getUserInfo in TEN31 Pass is the latest identification for the latest identity if user provided
    // these (completed signup which we can assume here, see above), it's been verified (expiry set, which we can also
    // assume here as only verified users can give grants) and not expired, or an empty list otherwise.
    identifications: [IdentificationInfo?],
}

export interface IdentificationInfo {
    /** The provider that performed the identification verification */
    provider: string,
    /** Date string encoding the expiry time */
    expiry: string,
}

export interface ServiceGrantInfo {
    id: string,
    /** Date string encoding the time when the service grant was created */
    timestamp: string,
    /** Id of the service this grant is for */
    serviceId: string,
    /** Id of the app that requested this service grant */
    appId: string,
    /** JWT (JSON web token) representing the service grant */
    // note: token is nullable in TEN31 Pass but only for an invalid config. We can assume here that TEN31 Pass is
    // correctly configured.
    token: string,
    /** Map of service usage id (instead of service usage grant id; by mistake?) -> usage parameters */
    usages: Record<string, UsageParameters>,
    /**
     * Consumed / used service usage grants.
     * Map of service usage id (instead of service usage grant id; by mistake?) -> consumption metadata.
     * Only available for requests that include the valid service api key of the service this grant is for.
     */
    consumption?: Record<string, Record<string, unknown>>,
    /**
     * Info about the user who confirmed this service grant.
     * Only available for requests that include the valid service api key of the service this grant is for.
     */
    user?: UserInfo,
}

// Check for redirect grant response. Do this immediately, before other code potentially changes the url, e.g. via
// history.replaceState, and also to immediately remove the redirect response artifacts from the url.
RedirectBehavior.getRedirectResponse('grant-response', [/^grant-for-app-.+$/], [/^grant-for-service-.+$/]);

export default class Ten31PassApi {
    public readonly endpoint: Endpoint | string;
    private readonly _endpointOrigin: string;
    private readonly _redirectBehavior: RedirectBehavior;
    private readonly _popupBehavior: PopupBehavior;

    private static getRequestId(appId: string, serviceIds: string[] = []) {
        // Calculate a request id from data that is available at request time as well as after redirect responses.
        // Unfortunately this request id is not unique as all requests for the same app id and services will have the
        // same request id.
        return [appId, ...serviceIds.sort()].join('_');
    }

    constructor(endpoint: Endpoint | string) {
        endpoint = endpoint.replace(/\/?$/, '/'); // make sure there is a trailing slash
        this.endpoint = endpoint;
        this._endpointOrigin = new URL(endpoint).origin;
        this._redirectBehavior = new RedirectBehavior(endpoint);
        this._popupBehavior = new PopupBehavior(endpoint);
    }

    /**
     * Open TEN31 Pass's signup page, either in a popup or by redirecting the page.
     * Because we can not determine, whether a user signed up, this method returns void.
     * This call does not support a recoverable redirect state, because TEN31 Pass does not redirect back from the
     * signup flow.
     */
    signup(asPopup = true): void {
        if (asPopup) {
            this._popupBehavior.call('signup');
        } else {
            this._redirectBehavior.call('signup');
        }
    }

    /**
     * Request grants for an app and optional services. TEN31 Pass can be opened as a popup or by redirecting the page.
     * Popups can respond via postMessage in which case the result is returned here. For redirects, the result can be
     * checked via getRedirectGrantResponse. Defaults to using a popup and preferredResponseType POST_MESSAGE.
     * Note that the preferredResponseType can not be guaranteed. Availability of ResponseType...
     * - POST_MESSAGE depends on whether JavaScript and window.opener are available on TEN31 Pass.
     * - IMMEDIATE_REDIRECT depends on whether Javascript is available on TEN31 Pass.
     * If preferredResponseType is not available, the fallback is ResponseType.REDIRECT which is always available.
     * On fallback to ResponseType.REDIRECT, popup requests for ResponseType.POST_MESSAGE will not resolve and the
     * response must be checked via getRedirectGrantResponse in the popup after the popup redirects back.
     *
     * Usage of ResponseType.POST_MESSAGE even when not opening a popup is theoretically possible if the calling page
     * itself is already a popup, but this is currently not encouraged by the api and the postMessage response would
     * needed to be checked manually by the page that opened the popup.
     */
    requestGrants(
        appId: string,
        services?: ServiceRequest[],
        asPopup?: true,
        options?: {
            preferredResponseType?: ResponseType.POST_MESSAGE, // asPopup: true is only option that allows POST_MESSAGE
            redirectRecoverableState?: any, // only used in case that ResponseType.REDIRECT is getting used as fallback
            popupOverlay?: PopupBehavior.OverlayOptions['overlay'],
        },
    ): Promise<GrantResponse>; // ResponseType.POST_MESSAGE is the only response type for which we get an async response
    requestGrants(
        appId: string,
        services?: ServiceRequest[],
        asPopup?: true,
        options?: {
            preferredResponseType?: Exclude<ResponseType, ResponseType.POST_MESSAGE>,
            redirectRecoverableState?: any,
            popupOverlay?: PopupBehavior.OverlayOptions['overlay'],
        },
    ): void; // always void for response types other than postMessage
    requestGrants(
        appId: string,
        services?: ServiceRequest[],
        asPopup?: boolean,
        options?: {
            preferredResponseType?: Exclude<ResponseType, ResponseType.POST_MESSAGE>, // allowed also for asPopup: false
            redirectRecoverableState?: any,
        },
    ): void; // always void for non-popups or response types other than postMessage
    requestGrants( // generic definition for when asPopup or preferredResponseType are passed as variables
        appId: string,
        services?: ServiceRequest[],
        asPopup?: boolean,
        options?: {
            preferredResponseType?: ResponseType,
            redirectRecoverableState?: any,
            popupOverlay?: PopupBehavior.OverlayOptions['overlay'],
        },
    ): Promise<GrantResponse> | void;
    requestGrants(
        appId: string,
        services: ServiceRequest[] = [],
        asPopup: boolean = true,
        {
            preferredResponseType = asPopup ? ResponseType.POST_MESSAGE : ResponseType.REDIRECT,
            redirectRecoverableState,
            popupOverlay = asPopup,
        }: {
            preferredResponseType?: ResponseType,
            redirectRecoverableState?: any,
            popupOverlay?: PopupBehavior.OverlayOptions['overlay'],
        } = {},
    ): Promise<GrantResponse> | void {
        // convert our more user-friendly request format into ten31's
        const request = {
            app: appId,
            services: services.reduce((convertedServices, { serviceId, usages }) => {
                if (serviceId in convertedServices) throw new Error('TEN31 Pass request invalid');
                convertedServices[serviceId] = (usages || []).reduce((convertedUsages, { usageId, parameters }) => {
                    if (usageId in convertedUsages) throw new Error('TEN31 Pass request invalid');
                    convertedUsages[usageId] = parameters || {};
                    return convertedUsages;
                }, {} as Record</* usage id */ string, UsageParameters>);
                return convertedServices;
            }, {} as Record</* service id */ string, Record</* usage id */ string, UsageParameters>>),
        };

        const recoverableStateOptions = redirectRecoverableState !== undefined ? {
            requestId: Ten31PassApi.getRequestId(appId, services.map(({ serviceId }) => serviceId)),
            recoverableState: redirectRecoverableState,
        } : {};

        if (asPopup) {
            if (preferredResponseType === ResponseType.POST_MESSAGE) {
                // Returns the grant response promise
                return this._popupBehavior.call<GrantResponse>('grants/request', request, {
                    preferredResponseType,
                    responseEvent: 'grant-response',
                    requiredKeys: ['app'],
                    ...recoverableStateOptions,
                    overlay: popupOverlay,
                });
            } else {
                // Returns void
                return this._popupBehavior.call('grants/request', request, {
                    preferredResponseType,
                    ...recoverableStateOptions,
                    overlay: popupOverlay,
                });
            }
        } else {
            this._redirectBehavior.call('grants/request', request, {
                preferredResponseType: preferredResponseType as Exclude<ResponseType, ResponseType.POST_MESSAGE>,
                ...recoverableStateOptions,
            });
        }
    }

    /**
     * Check for a GrantResponse received via redirect, for requests that redirected the page instead of using a popup.
     */
    getRedirectGrantResponse(): { response: GrantResponse, recoveredState: any | null } | null {
        const redirectResponse = RedirectBehavior.getRedirectResponse(
            'grant-response',
            [/^grant-for-app-.+$/],
            [/^grant-for-service-.+$/],
            this._endpointOrigin,
        );
        if (!redirectResponse) return null;

        // Convert redirect response to GrantResponse
        let appId: string;
        let appGrant: string;
        const serviceGrants: Record<string, string> = {}; // map of service id -> service grant id
        for (const [key, value] of Object.entries(redirectResponse)) {
            if (key.startsWith('grant-for-app-')) {
                appId = key.replace('grant-for-app-', '');
                appGrant = value;
            } else if (key.startsWith('grant-for-service-')) {
                serviceGrants[key.replace('grant-for-service-', '')] = value;
            }
        }

        // Recover state
        const requestId = Ten31PassApi.getRequestId(appId!, Object.keys(serviceGrants));
        const recoveredState = RedirectBehavior.getRecoverableState(requestId);

        return {
            response: { app: appGrant!, services: serviceGrants },
            recoveredState,
        };
    }

    /**
     * Fetch info about an app in the TEN31 Pass database.
     * Deactivated apps are reported as null.
     */
    async getAppInfo(appId: string): Promise<AppInfo | null> {
        return this._fetchData(`api/public/app/${appId}`);
    }

    /**
     * Fetch info about a service and associated supported service usages in the TEN31 Pass database.
     * Deactivated services are reported as null. Deactivated service usages are omitted.
     */
    async getServiceInfo(serviceId: string): Promise<ServiceInfo | null> {
        return this._fetchData(`api/public/service/${serviceId}`);
    }

    /**
     * Fetch info about an app grant and the associated app as well as the user who granted the app access.
     * Expired / deactivated grants and grants for deactivated apps are reported as null.
     */
    async getAppGrantInfo(appGrantId: string): Promise<AppGrantInfo | null> {
        return this._fetchData(`api/public/grant/app/${appGrantId}`);
    }

    /**
     * Fetch info about a service grant and the associated service usage grants and parameters.
     * Grants for deactivated services are reported as null.
     * Optionally, info about which usage grants have been consumed already and the associated consumption metadata as
     * well as info about the user who granted the service access can be fetched by including the valid service api key
     * of the service this grant is for. Invalid service api keys behave like not being submitted.
     * When submitting the api key for your registered service, be sure that it can safely be used in your code without
     * being leaked.
     */
    async getServiceGrantInfo(serviceGrantId: string): Promise<Omit<ServiceGrantInfo, 'consumption' | 'user'> | null>
    async getServiceGrantInfo(serviceGrantId: string, serviceApiKey: string): Promise<ServiceGrantInfo | null>
    async getServiceGrantInfo(serviceGrantId: string, serviceApiKey?: string)
        : Promise<ServiceGrantInfo | Omit<ServiceGrantInfo, 'consumption' | 'user'> | null> {
        return this._fetchData(`api/public/grant/service/${serviceGrantId}`, serviceApiKey);
    }

    /**
     * Consume service usage grants of a service grant, optionally adding arbitrary metadata like oasis contract id,
     * swap addresses, etc.
     * The call terminates with null, if the service grant's associated service is deactivated, and throws for invalid
     * service api keys, usage grants not associated with the service grant identified by serviceGrantId, or if
     * attempting to consume a usage grant which has already been consumed.
     * When submitting the api key for your registered service, be sure that it can safely be used in your code without
     * being leaked.
     */
    async consumeServiceGrant(
        serviceGrantId: string,
        usageGrants: Array<{ usageGrantId: string, metadata?: Record<string, unknown> }>,
        serviceApiKey: string,
    ): Promise<Required<ServiceGrantInfo> | null> {
        return this._fetchData(`api/public/grant/service/${serviceGrantId}/consume`, serviceApiKey, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            // convert our more user-friendly request format into ten31's
            body: JSON.stringify(usageGrants.reduce((convertedUsageGrants, { usageGrantId, metadata }) => {
                if (usageGrantId in convertedUsageGrants) throw new Error('TEN31 Pass request invalid');
                convertedUsageGrants[usageGrantId] = metadata || {};
                return convertedUsageGrants;
            }, {} as Record</* usage grant id */ string, /* metadata */ Record<string, unknown>>)),
        });
    }

    private async _fetchData(path: string, serviceApiKey?: string, options: RequestInit = {}): Promise<any | null> {
        try {
            const response = await fetch(this.endpoint + path, {
                ...options,
                headers: {
                    ...options.headers,
                    ...(serviceApiKey ? { 'X-Service-Api-Key': serviceApiKey } : null),
                }
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`${response.status}: ${response.statusText}`);
            return await response.json();
        } catch (e: any) {
            throw new Error(`TEN31 Pass request to ${path} failed: ${e.message}`, { cause: e });
        }
    }
}

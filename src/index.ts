import { postRequest } from './utils';

export enum Endpoint {
    MAIN = 'https://pass.ten31.com/',
    TEST = 'https://test.pass.ten31.com/',
    LOCAL = 'http://localhost:8080/',
}

export interface ServiceRequest {
    serviceId: string,
    usages?: Array<{
        usageId: string,
        parameters?: Record<string, unknown>,
    }>,
}

export interface GrantResponse {
    app: string,
    services: Record<string, string>,
}

// Not exposed. Instead, we throw on errors.
enum ResponseStatus {
    Success = 'Success',
    Error = 'Error',
    InvalidRequest = 'InvalidRequest',
    Unknown = 'Unknown',
}

export class Ten31PassApi {
    private readonly _endpointOrigin: string;

    constructor(public readonly enpoint: Endpoint | string) {
        this._endpointOrigin = new URL(this.enpoint).origin;
    }

    async requestGrants(appId: string, services?: ServiceRequest[], asPopup?: true): Promise<GrantResponse>;
    async requestGrants(appId: string, services?: ServiceRequest[], asPopup?: false): Promise<void>;
    async requestGrants(appId: string, services?: ServiceRequest[], asPopup?: boolean): Promise<GrantResponse | void>;
    async requestGrants(appId: string, services: ServiceRequest[] = [], asPopup: boolean = true)
        : Promise<GrantResponse | void> {
        // convert our more user-friendly request format into ten31's
        const request = {
            app: appId,
            services: services.reduce((convertedServices, { serviceId, usages }) => {
                if (serviceId in convertedServices) throw new Error('TEN31 PASS request invalid');
                convertedServices[serviceId] = (usages || []).reduce((convertedUsages, { usageId, parameters }) => {
                    if (usageId in convertedUsages) throw new Error('TEN31 PASS request invalid');
                    convertedUsages[usageId] = parameters || {};
                    return convertedUsages;
                }, {} as Record</* usage id */ string, /* parameters */ Record<string, unknown>>);
                return convertedServices;
            }, {} as Record</*service id*/ string, Record</*usage id*/ string, /*params*/ Record<string, unknown>>>),
        };

        const popup = postRequest(`${this.enpoint}grants/request`, request, asPopup);
        if (!popup) return; // redirect request

        return new Promise<GrantResponse>((resolve, reject) => {
            let closeCheckInterval = -1;
            const onPopupMessage = (event: MessageEvent<unknown>) => {
                if (event.origin !== this._endpointOrigin || !event.data || typeof event.data !== 'object'
                    || (event.data as any).event !== 'grant-response') return;
                const grantResponseMessage = event.data as (GrantResponse & { status: ResponseStatus.Success })
                    | { status: Exclude<ResponseStatus, ResponseStatus.Success> };
                // ignore unspecified errors (e.g. user got logged out or used wrong totp token) as user can try again.
                if ([ResponseStatus.Error, ResponseStatus.Unknown].includes(grantResponseMessage.status)) return;
                window.removeEventListener('message', onPopupMessage);
                window.clearInterval(closeCheckInterval);

                if (!grantResponseMessage.status
                    || (grantResponseMessage.status === ResponseStatus.Success && !grantResponseMessage.app)) {
                    // should never happen
                    reject(new Error('TEN31 PASS did not return a valid response.'));
                } else if (grantResponseMessage.status !== ResponseStatus.Success) {
                    reject(new Error(`TEN31 PASS rejected grants with error: ${grantResponseMessage.status}`, {
                        cause: new Error(grantResponseMessage.status),
                    }));
                } else {
                    // only expose expected properties
                    resolve({
                        app: grantResponseMessage.app,
                        services: grantResponseMessage.services || {},
                    });
                }
            };
            window.addEventListener('message', onPopupMessage);
            closeCheckInterval = window.setInterval(() => {
                if (!popup.closed) return;
                window.removeEventListener('message', onPopupMessage);
                window.clearInterval(closeCheckInterval);
                reject(new Error('TEN31 PASS popup closed'));
            }, 300);
        });
    }
}

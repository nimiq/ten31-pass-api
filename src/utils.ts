export function postRequest(url: string, data: Record<string, unknown>, target: WindowProxy = window): void {
    const form = document.createElement('form');
    form.setAttribute('method', 'post');
    form.setAttribute('action', url);
    form.style.display = 'none';

    for (const [name, value] of Object.entries(data)) {
        const entry = document.createElement('input');
        entry.setAttribute('type', 'hidden');
        entry.setAttribute('name', name);
        entry.setAttribute('value', typeof value === "string" ? value : JSON.stringify(value));
        form.appendChild(entry);
    }

    if (target !== window) {
        target.name = target.name || generateWindowName(url);
        form.setAttribute('target', target.name);
    }

    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 300);
}

export function generateWindowName(url: string): string {
    return `ten31-pass_${url}_${Date.now()}`;
}

export function isIOS(): boolean {
    // taken from @nimiq/utils/BrowserDetection
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

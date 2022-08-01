export function postRequest(url: string, data: Record<string, unknown>, asPopup?: true): WindowProxy;
export function postRequest(url: string, data: Record<string, unknown>, asPopup: false): null;
export function postRequest(url: string, data: Record<string, unknown>, asPopup: boolean): WindowProxy | null;
export function postRequest(url: string, data: Record<string, unknown>, asPopup = true): WindowProxy | null {
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

    let popup: WindowProxy | null = null;
    if (asPopup) {
        const popupName = `ten31-pass_${url}_${Date.now()}`;
        form.setAttribute('target', popupName);
        popup = window.open(
            url,
            popupName,
            `left=${window.innerWidth / 2 - 400},top=75,width=800,height=850,location=yes`,
        );
        if (!popup) throw new Error('TEN31 Pass popup failed to open.');

    }
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 300);
    return popup;
}


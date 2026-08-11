export async function initializeLine(config, liff = globalThis.liff) {
  const line = config.integrations?.line || {};
  const disabled = {
    enabled: false,
    ready: false,
    inClient: false,
    loggedIn: false,
    profile: null,
    error: null
  };

  if (!line.enabled || line.mode !== 'liff' || !line.liffId) return disabled;
  if (!liff?.init) {
    return { ...disabled, enabled: true, error: 'LIFF SDK is unavailable' };
  }

  try {
    await liff.init({ liffId: line.liffId });
    const inClient = Boolean(liff.isInClient?.());
    const loggedIn = Boolean(liff.isLoggedIn?.());
    let profile = null;

    if (loggedIn && Array.isArray(line.scopes) && line.scopes.includes('profile') && liff.getProfile) {
      try {
        const raw = await liff.getProfile();
        profile = raw ? {
          displayName: String(raw.displayName || ''),
          pictureUrl: String(raw.pictureUrl || ''),
          statusMessage: String(raw.statusMessage || '')
        } : null;
      } catch (error) {
        console.warn('LIFF profile unavailable', error);
      }
    }

    return {
      enabled: true,
      ready: true,
      inClient,
      loggedIn,
      profile,
      error: null
    };
  } catch (error) {
    console.error('LIFF initialization failed', error);
    return {
      ...disabled,
      enabled: true,
      error: error?.message || String(error)
    };
  }
}

export function bookingSource(lineContext) {
  if (!lineContext?.enabled) return 'business-booking-template-v0.3';
  if (lineContext.inClient) return 'line-liff';
  if (lineContext.ready) return 'liff-external-browser';
  return 'line-configured-fallback';
}

export function prefillFromLineProfile(form, lineContext) {
  const displayName = lineContext?.profile?.displayName?.trim();
  if (!displayName) return false;
  const name = form?.querySelector?.('[name="name"]');
  if (!name || name.value) return false;
  name.value = displayName;
  return true;
}

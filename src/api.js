function readByKey(object, key) {
  return String(key || '').split('.').filter(Boolean).reduce((value, part) => value?.[part], object);
}

export function createBookingApi(config) {
  const api = config.integrations.bookingApi;
  const development = config.development || {};
  const mockMode = development.mockMode || !api.enabled;

  return {
    isMock: mockMode,

    async getAvailability(date) {
      if (mockMode) return [...(development.mockSlots || [])];
      const url = new URL(api.baseUrl);
      url.searchParams.set(api.availabilityParam || 'date', date);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`availability request failed: ${response.status}`);
      const data = await response.json();
      const slots = readByKey(data, api.availabilityResponseKey || 'availableSlots');
      return Array.isArray(slots) ? slots : [];
    },

    async submitBooking(payload) {
      if (mockMode) {
        return { success: true, mock: true, bookingId: `mock-${Date.now()}` };
      }
      const response = await fetch(api.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`booking request failed: ${response.status}`);
      return response.json();
    }
  };
}

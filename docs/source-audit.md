# Source audit: TAMAFIT/-reserve

`TAMAFIT/-reserve` is treated as read-only production reference. This repository must not modify it.

The current reservation frontend contains business-specific values directly in the page, including these categories:

- business name and reservation title
- address and contact details
- GAS Web App endpoint
- LINE friend URL
- Google Maps URL
- owner email
- Google Ads / GA4 identifiers and conversion target
- branding colors and assets
- trial-booking-specific copy and payload fields

Business Booking Template v0.1 moves these categories behind `business.config.json` and an API adapter. Production values from `TAMAFIT/-reserve` are intentionally not copied here.

## Compatibility target

The first GAS adapter is compatible with the basic contract observed in the existing frontend:

- availability: GET with a date query parameter
- availability response: JSON containing an `availableSlots` array
- reservation: POST JSON payload to the same endpoint

The exact GAS backend and Google Calendar provisioning are intentionally deferred to Business Factory v0.2 so this template can be tested without touching current production services.

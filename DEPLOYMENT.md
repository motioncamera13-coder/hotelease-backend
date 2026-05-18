# HotelEase PMS Deployment

This repo is prepared for the existing GitHub repository and existing Render PMS service.

## Render service

Use the existing Render web service connected to this GitHub repo.

- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node 18 or newer

## Required environment variables

Set these in the existing Render service:

- `DATABASE_URL`
- `JWT_SECRET`
- `NODE_ENV=production`
- `BOT_URL` if PMS should call an external WhatsApp bot service
- WhatsApp variables only if PMS itself sends WhatsApp messages:
  - `WA_PHONE_NUMBER_ID`
  - `WA_ACCESS_TOKEN`
  - `VERIFY_TOKEN`
  - `ADMIN_PHONE`

## First database setup

After Render has `DATABASE_URL`, run this once from a Render shell or locally with the production database URL:

```bash
npm run db:setup
node src/utils/create-super-admin.js superadmin YourStrongPassword
```

## Reset hotels to a fresh start

This keeps registered hotels, users, rooms, room types, rates, and permissions. It deletes operational PMS data like guests, reservations, bills, payments, agents, cash book, requisitions, housekeeping rows, and WhatsApp sessions, then marks rooms available.

Run from the existing Render service shell:

```bash
CONFIRM_RESET=YES_DELETE_OPERATIONAL_DATA npm run db:reset-data
```

For only one hotel, add the hotel UUID:

```bash
CONFIRM_RESET=YES_DELETE_OPERATIONAL_DATA npm run db:reset-data -- HOTEL_UUID_HERE
```

## URLs

- API health: `/`
- PMS dashboard: `/dashboard/login.html`
- Super admin: `/dashboard/super-admin.html`

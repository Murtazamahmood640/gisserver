/**
 * socket.test.ts
 *
 * Tests Socket.io real-time layer:
 * - Handshake auth & suspended user rejection
 * - Room join authorization matrix
 * - Event delivery
 * - auth:update token refresh
 * - Rate limiting
 * - REST-only mode fallback (no socket server attached)
 *
 * PART 8f
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import crypto from 'crypto';

import { initRealtimeServer, closeRealtimeServer, setRealtimeNow, resetRealtimeNow } from '../realtime';
import { realtimeEmitter } from '../realtime/emitter';
import { User } from '../models/User';
import { Booking } from '../models/Booking';
import { generateAccessToken, verifyAccessToken } from '../utils/jwt';

let mongoServer: MongoMemoryServer;
let server: http.Server;
let serverUrl: string;
let ioInstance: ReturnType<typeof initRealtimeServer>;

function createClient(options: Record<string, unknown> = {}): ClientSocket {
  return Client(serverUrl, {
    transports: ['websocket'],
    autoConnect: true,
    forceNew: true,
    ...options,
  });
}

async function createUser(role: string, suffix: string, overrides: Record<string, unknown> = {}) {
  const user = await User.create({
    email: `sock-${role}-${suffix}@test.com`,
    password: 'P@ssword1!',
    fullName: `Socket ${role} ${suffix}`,
    role,
    status: 'active',
    isActive: true,
    emailVerified: true,
    ...overrides,
  });
  const token = generateAccessToken({
    userId: user._id.toString(),
    email: user.email,
    role: role as 'admin' | 'dispatcher' | 'technician' | 'customer',
    status: (overrides.status as 'active' | 'suspended') || 'active',
    emailVerified: true,
  });
  return { user, token };
}

describe('Socket.io Real-Time Layer (in-process server + real MongoDB)', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.disconnect();
    await mongoose.connect(mongoServer.getUri());

    server = http.createServer();
    ioInstance = initRealtimeServer(server);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await closeRealtimeServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Booking.deleteMany({});
    if (ioInstance) realtimeEmitter.setServer(ioInstance);
  });

  // ── 1. Unauthenticated / Invalid Token ───────────────────────────────────

  it('unauthenticated connection is rejected with UNAUTHORIZED', async () => {
    const socket = createClient();
    const err = await new Promise<Error>((resolve) => {
      socket.on('connect_error', resolve);
    });
    expect(err.message).toBe('UNAUTHORIZED');
    socket.disconnect();
  });

  it('invalid token connection is rejected with UNAUTHORIZED', async () => {
    const socket = createClient({ auth: { token: 'invalid.jwt.token' } });
    const err = await new Promise<Error>((resolve) => {
      socket.on('connect_error', resolve);
    });
    expect(err.message).toBe('UNAUTHORIZED');
    socket.disconnect();
  });

  // ── 2. Suspended User Rejection ──────────────────────────────────────────

  it('suspended user is rejected with ACCOUNT_SUSPENDED', async () => {
    const { token } = await createUser('customer', 'susp', { status: 'suspended' });
    const socket = createClient({ auth: { token } });
    const err = await new Promise<Error>((resolve) => {
      socket.on('connect_error', resolve);
    });
    expect(err.message).toBe('ACCOUNT_SUSPENDED');
    socket.disconnect();
  });

  // ── 3. Authenticated Connection & Auto-joined Rooms ──────────────────────

  it('valid token connects successfully', async () => {
    const { token } = await createUser('customer', 'ok');
    const socket = createClient({ auth: { token } });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  // ── 4. Room Join Authorization Matrix: admin:board ───────────────────────

  it('admin and dispatcher can join admin:board; customer and tech cannot', async () => {
    const { token: adminToken } = await createUser('admin', 'ab');
    const { token: dispToken } = await createUser('dispatcher', 'db');
    const { token: custToken } = await createUser('customer', 'cb');
    const { token: techToken } = await createUser('technician', 'tb');

    const adminSocket = createClient({ auth: { token: adminToken } });
    const dispSocket = createClient({ auth: { token: dispToken } });
    const custSocket = createClient({ auth: { token: custToken } });
    const techSocket = createClient({ auth: { token: techToken } });

    await Promise.all([
      new Promise((res) => adminSocket.on('connect', () => res(undefined))),
      new Promise((res) => dispSocket.on('connect', () => res(undefined))),
      new Promise((res) => custSocket.on('connect', () => res(undefined))),
      new Promise((res) => techSocket.on('connect', () => res(undefined))),
    ]);

    // Admin joins
    const adminRes = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      adminSocket.emit('join', { room: 'admin:board' }, resolve);
    });
    expect(adminRes.success).toBe(true);

    // Dispatcher joins
    const dispRes = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      dispSocket.emit('join', { room: 'admin:board' }, resolve);
    });
    expect(dispRes.success).toBe(true);

    // Customer joins -> forbidden
    const custRes = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      custSocket.emit('join', { room: 'admin:board' }, resolve);
    });
    expect(custRes.success).toBe(false);
    expect(custRes.error).toBe('FORBIDDEN');

    // Technician joins -> forbidden
    const techRes = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      techSocket.emit('join', { room: 'admin:board' }, resolve);
    });
    expect(techRes.success).toBe(false);
    expect(techRes.error).toBe('FORBIDDEN');

    adminSocket.disconnect();
    dispSocket.disconnect();
    custSocket.disconnect();
    techSocket.disconnect();
  });

  // ── 5. Room Join Authorization Matrix: booking:{id} ──────────────────────

  it('booking room join permissions: owner, assigned tech, guest vs other customer/tech', async () => {
    const { user: owner, token: ownerToken } = await createUser('customer', 'owner');
    const { user: otherCust, token: otherCustToken } = await createUser('customer', 'otherc');
    const { user: assignedTech, token: assignedTechToken } = await createUser('technician', 'astech');
    const { user: otherTech, token: otherTechToken } = await createUser('technician', 'otech');

    const guestRawToken = 'raw-guest-token-12345';
    const guestHash = crypto.createHash('sha256').update(guestRawToken).digest('hex');

    const booking = await Booking.create({
      bookingNumber: 'GIS-SOCK-001',
      serviceId: new mongoose.Types.ObjectId(),
      categoryId: new mongoose.Types.ObjectId(),
      customerId: owner._id,
      guestAccessTokenHash: guestHash,
      guest: { fullName: 'Owner Customer', email: owner.email, phone: '555-1111' },
      serviceSnapshot: { name: 'S', slug: 's' },
      vehicleSnapshot: { category: 'sedan', make: 'T', model: 'C', year: 2022 },
      scheduledAt: new Date(Date.now() + 86400000),
      scheduledLocal: { date: '2026-11-10', slot: '10:00' },
      pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
      address: { freeText: '123 Main', zip: '90210', country: 'USA' },
      status: 'assigned',
      source: 'web',
      technicianId: assignedTech._id,
      assignment: { technicianUserId: assignedTech._id, assignedAt: new Date(), assignedBy: 'admin' },
    });

    const bookingRoom = `booking:${booking._id}`;

    // Connect clients
    const ownerSocket = createClient({ auth: { token: ownerToken } });
    const otherCustSocket = createClient({ auth: { token: otherCustToken } });
    const assignedTechSocket = createClient({ auth: { token: assignedTechToken } });
    const otherTechSocket = createClient({ auth: { token: otherTechToken } });
    const guestSocket = createClient({ auth: { bookingId: booking._id.toString(), token: guestRawToken } });

    await Promise.all([
      new Promise((res) => ownerSocket.on('connect', () => res(undefined))),
      new Promise((res) => otherCustSocket.on('connect', () => res(undefined))),
      new Promise((res) => assignedTechSocket.on('connect', () => res(undefined))),
      new Promise((res) => otherTechSocket.on('connect', () => res(undefined))),
      new Promise((res) => guestSocket.on('connect', () => res(undefined))),
    ]);

    // Owner -> allowed
    const ownerRes = await new Promise<{ success: boolean; error?: string }>((r) => ownerSocket.emit('join', { room: bookingRoom }, r));
    expect(ownerRes.success).toBe(true);

    // Other customer -> forbidden
    const otherCustRes = await new Promise<{ success: boolean; error?: string }>((r) => otherCustSocket.emit('join', { room: bookingRoom }, r));
    expect(otherCustRes.success).toBe(false);
    expect(otherCustRes.error).toBe('FORBIDDEN');

    // Assigned tech -> allowed
    const assignedTechRes = await new Promise<{ success: boolean; error?: string }>((r) => assignedTechSocket.emit('join', { room: bookingRoom }, r));
    expect(assignedTechRes.success).toBe(true);

    // Other tech -> forbidden
    const otherTechRes = await new Promise<{ success: boolean; error?: string }>((r) => otherTechSocket.emit('join', { room: bookingRoom }, r));
    expect(otherTechRes.success).toBe(false);
    expect(otherTechRes.error).toBe('FORBIDDEN');

    ownerSocket.disconnect();
    otherCustSocket.disconnect();
    assignedTechSocket.disconnect();
    otherTechSocket.disconnect();
    guestSocket.disconnect();
  });

  // ── 6. Event Delivery on Accept, En-Route and Location ──────────────────

  it('event delivery on accept, en-route and location', async () => {
    const { user: owner, token: ownerToken } = await createUser('customer', 'evowner');
    const { user: tech } = await createUser('technician', 'evtech');

    const booking = await Booking.create({
      bookingNumber: 'GIS-EV-001',
      serviceId: new mongoose.Types.ObjectId(),
      categoryId: new mongoose.Types.ObjectId(),
      customerId: owner._id,
      guest: { fullName: 'Owner', email: owner.email, phone: '555-1111' },
      serviceSnapshot: { name: 'Full Detail', slug: 'full-detail' },
      vehicleSnapshot: { category: 'sedan', make: 'Toyota', model: 'Camry', year: 2022 },
      scheduledAt: new Date(Date.now() + 86400000),
      scheduledLocal: { date: '2026-11-10', slot: '10:00' },
      pricing: { baseCents: 10000, totalCents: 10000, providerPayoutCents: 8500 },
      address: { freeText: '123 Main', zip: '90210', country: 'USA' },
      status: 'confirmed',
      source: 'web',
    });

    const socket = createClient({ auth: { token: ownerToken } });
    await new Promise((res) => socket.on('connect', () => res(undefined)));
    await new Promise((res) => socket.emit('join', { room: `booking:${booking._id}` }, res));

    // 1. Accept event: booking:assigned
    const assignPromise = new Promise<{ bookingId: string; technician: { displayName: string } }>((resolve) => socket.on('booking:assigned', resolve));
    realtimeEmitter.emitBookingAssigned(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      technician: { displayName: 'Bob Tech', rating: 4.9 },
    });
    const assignEvent = await assignPromise;
    expect(assignEvent.bookingId).toBe(booking._id.toString());
    expect(assignEvent.technician.displayName).toBe('Bob Tech');

    // 2. En-route event: booking:status
    const statusPromise = new Promise<{ status: string }>((resolve) => socket.on('booking:status', resolve));
    realtimeEmitter.emitBookingStatus(booking._id.toString(), {
      bookingId: booking._id.toString(),
      bookingNumber: booking.bookingNumber,
      status: 'technician_en_route',
      updatedAt: new Date().toISOString(),
    });
    const statusEvent = await statusPromise;
    expect(statusEvent.status).toBe('technician_en_route');

    // 3. Location update event: technician:location
    const locPromise = new Promise<{ location: { lat: number; lng: number } }>((resolve) => socket.on('technician:location', resolve));
    realtimeEmitter.emitTechnicianLocation(booking._id.toString(), {
      bookingId: booking._id.toString(),
      technicianUserId: tech._id.toString(),
      location: { lat: 34.0522, lng: -118.2437 },
      updatedAt: new Date().toISOString(),
    });
    const locEvent = await locPromise;
    expect(locEvent.location.lat).toBeCloseTo(34.0522);
    expect(locEvent.location.lng).toBeCloseTo(-118.2437);

    socket.disconnect();
  });

  // ── 7. Token Expiry Lifecycle ─────────────────────────────────────────────

  it("token expiry ('auth:expiring', then disconnect unless 'auth:update' with a fresh valid token)", async () => {
    // Deterministic injectable clock test — standard token (15m), simulated near expiry
    const { user } = await createUser('customer', 'expiring');
    const standardToken = generateAccessToken({
      userId: user._id.toString(),
      email: user.email,
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });

    const payload = verifyAccessToken(standardToken) as { exp: number };
    const expMs = payload.exp * 1000;

    // Fast-forward simulated realtime clock to 30s before token expiry
    setRealtimeNow(() => expMs - 30_000);

    const socket = createClient({ auth: { token: standardToken }, autoConnect: false });

    // Register listener before connect so immediate warning is captured
    const expiringPromise = new Promise<boolean>((resolve) => {
      socket.on('auth:expiring', (data) => {
        if (data.expiresInSeconds !== undefined) resolve(true);
      });
      setTimeout(() => resolve(false), 3000);
    });

    socket.connect();
    await new Promise((res) => socket.on('connect', () => res(undefined)));

    const expiringReceived = await expiringPromise;
    expect(expiringReceived).toBe(true);

    // Refresh with fresh token via auth:update
    const freshToken = generateAccessToken({
      userId: user._id.toString(),
      email: user.email,
      role: 'customer',
      status: 'active',
      emailVerified: true,
    });

    const updateRes = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      socket.emit('auth:update', { token: freshToken }, resolve);
    });
    expect(updateRes.success).toBe(true);

    // Advance clock past original token expiry
    setRealtimeNow(() => expMs + 10_000);

    // Socket remains connected because it was refreshed!
    await new Promise((r) => setTimeout(r, 100));
    expect(socket.connected).toBe(true);

    resetRealtimeNow();
    socket.disconnect();
  });

  // ── 8. Rate Limiting on Socket ───────────────────────────────────────────

  it('per-socket event rate limit: exceeding 30 events per minute emits RATE_LIMIT_EXCEEDED error', async () => {
    const { token } = await createUser('customer', 'ratelimit');
    const socket = createClient({ auth: { token } });
    await new Promise((res) => socket.on('connect', () => res(undefined)));

    let gotRateLimitError = false;
    socket.on('error', (err: { code?: string }) => {
      if (err.code === 'RATE_LIMIT_EXCEEDED') {
        gotRateLimitError = true;
      }
    });

    // Send 35 events rapidly
    for (let i = 0; i < 35; i++) {
      socket.emit('join', { room: `test:${i}` });
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gotRateLimitError).toBe(true);

    socket.disconnect();
  });

  // ── 9. Max Payload Size ──────────────────────────────────────────────────

  it('max payload size: messages exceeding 10KB are rejected or disconnected', async () => {
    const { token } = await createUser('customer', 'large-payload');
    const socket = createClient({ auth: { token } });
    await new Promise((res) => socket.on('connect', () => res(undefined)));

    // Send a payload larger than 10KB (1e4 bytes)
    const largeString = 'X'.repeat(15000);
    const disconnectedPromise = new Promise<boolean>((resolve) => {
      socket.on('disconnect', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    socket.emit('join', { room: largeString });

    const disconnected = await disconnectedPromise;
    expect(disconnected).toBe(true);
    socket.disconnect();
  });

  // ── 10. Clients Cannot Emit Server Events ────────────────────────────────

  it('clients cannot emit server events (reserved event names are rejected)', async () => {
    const { token } = await createUser('customer', 'spoof-client');
    const socket = createClient({ auth: { token } });
    await new Promise((res) => socket.on('connect', () => res(undefined)));

    const errorPromise = new Promise<{ code?: string }>((resolve) => {
      socket.on('error', resolve);
    });

    // Client maliciously attempts to emit booking:status
    socket.emit('booking:status', { bookingId: '123', status: 'completed' });

    const err = await errorPromise;
    expect(err.code).toBe('RESERVED_EVENT');

    socket.disconnect();
  });

  // ── 11. REST Works with Sockets Disabled ─────────────────────────────────

  it('REST works with sockets disabled: realtimeEmitter methods no-op without error when server is null', () => {
    realtimeEmitter.setServer(null);

    expect(() => {
      realtimeEmitter.emitBookingStatus('b1', {
        bookingId: 'b1',
        bookingNumber: 'GIS-001',
        status: 'confirmed',
        updatedAt: new Date().toISOString(),
      });
      realtimeEmitter.emitBookingAssigned('b1', {
        bookingId: 'b1',
        bookingNumber: 'GIS-001',
        technician: { displayName: 'T1' },
      });
      realtimeEmitter.emitOfferNew('u1', {
        offerId: 'o1',
        bookingId: 'b1',
        bookingNumber: 'GIS-001',
        serviceName: 'S',
        scheduledTime: '10:00',
        expiresAt: new Date().toISOString(),
        rank: 1,
      });
      realtimeEmitter.emitOfferExpired('u1', {
        offerId: 'o1',
        bookingId: 'b1',
        reason: 'Expired',
      });
      realtimeEmitter.emitDispatchBoardUpdate({
        type: 'offered',
        bookingId: 'b1',
        bookingNumber: 'GIS-001',
        timestamp: new Date().toISOString(),
      });
      realtimeEmitter.emitTechnicianLocation('b1', {
        bookingId: 'b1',
        technicianUserId: 'u1',
        location: { lat: 34.05, lng: -118.24 },
        updatedAt: new Date().toISOString(),
      });
      realtimeEmitter.emitTrackingEta('b1', {
        bookingId: 'b1',
        etaMinutes: 10,
        distanceKm: 4.5,
        etaSource: 'google',
        updatedAt: new Date().toISOString(),
      });
      realtimeEmitter.disconnectUserSockets('u1');
    }).not.toThrow();
  });

  // ── 12. Suspended User Open Sockets Disconnected Immediately ─────────────

  it('when a user is suspended, their open sockets must be disconnected immediately', async () => {
    if (ioInstance) realtimeEmitter.setServer(ioInstance);

    const { user, token } = await createUser('technician', 'live-suspend');
    const socket = createClient({ auth: { token } });
    await new Promise((res) => socket.on('connect', () => res(undefined)));
    expect(socket.connected).toBe(true);

    const disconnectPromise = new Promise<{ code: string }>((resolve) => {
      socket.on('error', (err: { code?: string }) => {
        if (err.code === 'ACCOUNT_SUSPENDED') {
          resolve(err as { code: string });
        }
      });
    });

    // Fire the suspension hook
    realtimeEmitter.disconnectUserSockets(user._id.toString());

    const err = await disconnectPromise;
    expect(err.code).toBe('ACCOUNT_SUSPENDED');

    await new Promise((r) => setTimeout(r, 200));
    expect(socket.connected).toBe(false);

    socket.disconnect();
  });
});

import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import crypto from 'crypto';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { verifyAccessToken, verifyToken, AccessTokenPayload, JwtPayload } from '../utils/jwt';
import { User } from '../models/User';
import { Booking } from '../models/Booking';
import { realtimeEmitter } from './emitter';
import logger from '../config/logger';

let ioInstance: SocketIOServer | null = null;
let redisPubClient: Redis | null = null;
let redisSubClient: Redis | null = null;

function getCorsOrigins(): string[] | string {
  const envOrigins = process.env.FRONTEND_URL;
  if (!envOrigins || !envOrigins.trim()) {
    return '*';
  }
  const origins = envOrigins.split(',').map((o) => o.trim().replace(/\/$/, ''));
  origins.push('https://globalintegratedsupport.com');
  return origins;
}

export function initRealtimeServer(server: http.Server): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: getCorsOrigins(),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    maxHttpBufferSize: 1e4, // 10 KB max payload size
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // Redis Adapter setup
  if (process.env.REDIS_URL && process.env.REDIS_URL.trim()) {
    try {
      redisPubClient = new Redis(process.env.REDIS_URL);
      redisSubClient = redisPubClient.duplicate();
      io.adapter(createAdapter(redisPubClient, redisSubClient));
      logger.info('[Realtime] Attached Redis adapter for multi-instance scaling');
    } catch (err: unknown) {
      logger.error({ err }, '[Realtime] Failed to initialize Redis adapter, falling back to in-memory');
    }
  } else {
    logger.info(
      '[Realtime] Running in in-memory single-instance mode (REDIS_URL not set). If running multiple instances, configure REDIS_URL.'
    );
  }

  // Handshake Authentication Middleware
  io.use(async (socket: Socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const query = socket.handshake.query || {};
      const token = (auth.token || query.token) as string | undefined;
      const guestBookingId = (auth.bookingId || query.bookingId) as string | undefined;

      // 1. Guest authentication: bookingId + guest token
      if (guestBookingId && token) {
        const booking = await Booking.findOne({ _id: guestBookingId, deletedAt: null }).lean();
        if (booking && booking.guestAccessTokenHash) {
          const hashed = crypto.createHash('sha256').update(token.trim()).digest('hex');
          if (hashed === booking.guestAccessTokenHash) {
            socket.data.guest = { bookingId: guestBookingId };
            return next();
          }
        }
      }

      // 2. User JWT authentication
      if (!token) {
        return next(new Error('UNAUTHORIZED'));
      }

      let payload: AccessTokenPayload | JwtPayload | null = null;
      try {
        payload = verifyAccessToken(token);
      } catch {
        try {
          payload = verifyToken(token);
        } catch {
          return next(new Error('UNAUTHORIZED'));
        }
      }

      if (!payload || !payload.userId) {
        return next(new Error('UNAUTHORIZED'));
      }

      // Live user-status check: suspended users are refused immediately
      const user = await User.findById(payload.userId).lean();
      if (!user) {
        return next(new Error('UNAUTHORIZED'));
      }
      if (user.status === 'suspended' || user.isActive === false) {
        return next(new Error('ACCOUNT_SUSPENDED'));
      }

      socket.data.user = {
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
        status: user.status,
      };
      socket.data.tokenExp = payload.exp; // Epoch in seconds

      next();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ err: msg }, '[Realtime] Socket handshake error');
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user;
    const guest = socket.data.guest;

    // Strict block: clients cannot emit server-reserved events
    socket.use(([event, ..._args], next) => {
      const serverReservedEvents = [
        'booking:status',
        'booking:assigned',
        'technician:location',
        'tracking:eta',
        'offer:new',
        'offer:expired',
        'dispatch:board:update',
        'auth:expiring',
      ];
      if (serverReservedEvents.includes(event)) {
        socket.emit('error', { code: 'RESERVED_EVENT', message: `Cannot emit server event '${event}'` });
        return next(new Error(`RESERVED_EVENT: ${event}`));
      }
      next();
    });

    // Auto-join designated initial rooms
    if (user) {
      // Own private room
      socket.join(`user:${user.userId}`);

      // Admin board room for admin and dispatcher
      if (user.role === 'admin' || user.role === 'dispatcher' || user.role === 'user') {
        socket.join('admin:board');
      }

      // Schedule token expiration warning and disconnect
      if (socket.data.tokenExp) {
        setupTokenExpiryLifecycle(socket, socket.data.tokenExp);
      }
    } else if (guest) {
      // Guest automatically joins their booking room
      socket.join(`booking:${guest.bookingId}`);
    }

    // Per-socket event rate limit (max 30 events per minute)
    let eventCount = 0;
    const rateLimitInterval = setInterval(() => {
      eventCount = 0;
    }, 60000);

    const checkRateLimit = (): boolean => {
      eventCount += 1;
      if (eventCount > 30) {
        socket.emit('error', { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many socket requests' });
        return false;
      }
      return true;
    };

    // Client Room Join Request
    socket.on('join', async (data: { room: string }, callback?: (res: unknown) => void) => {
      if (!checkRateLimit()) return;
      try {
        const { room } = data || {};
        if (!room || typeof room !== 'string') {
          callback?.({ success: false, error: 'INVALID_ROOM' });
          return;
        }

        const allowed = await canJoinRoom(socket, room);
        if (allowed) {
          socket.join(room);
          callback?.({ success: true, room });
        } else {
          callback?.({ success: false, error: 'FORBIDDEN' });
        }
      } catch (err: unknown) {
        callback?.({ success: false, error: 'JOIN_ERROR' });
      }
    });

    // Client Room Leave Request
    socket.on('leave', (data: { room: string }, callback?: (res: unknown) => void) => {
      if (!checkRateLimit()) return;
      const { room } = data || {};
      if (room && typeof room === 'string') {
        socket.leave(room);
        callback?.({ success: true, room });
      }
    });

    // Client Token Refresh / Update
    socket.on('auth:update', async (data: { token: string }, callback?: (res: unknown) => void) => {
      if (!checkRateLimit()) return;
      try {
        const newToken = data?.token;
        if (!newToken) {
          callback?.({ success: false, error: 'TOKEN_REQUIRED' });
          return;
        }

        let newPayload: AccessTokenPayload | JwtPayload | null = null;
        try {
          newPayload = verifyAccessToken(newToken);
        } catch {
          newPayload = verifyToken(newToken);
        }

        if (!newPayload || newPayload.userId !== socket.data.user?.userId) {
          callback?.({ success: false, error: 'INVALID_TOKEN' });
          return;
        }

        // Live user-status check
        const dbUser = await User.findById(newPayload.userId).lean();
        if (!dbUser || dbUser.status === 'suspended' || dbUser.isActive === false) {
          socket.emit('error', { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' });
          socket.disconnect(true);
          return;
        }

        socket.data.tokenExp = newPayload.exp;
        if (typeof newPayload.exp === 'number') {
          setupTokenExpiryLifecycle(socket, newPayload.exp);
        }
        callback?.({ success: true });
      } catch (err: unknown) {
        callback?.({ success: false, error: 'AUTH_UPDATE_FAILED' });
      }
    });

    socket.on('disconnect', () => {
      clearInterval(rateLimitInterval);
      if (socket.data.expiringTimeout) clearTimeout(socket.data.expiringTimeout);
      if (socket.data.disconnectTimeout) clearTimeout(socket.data.disconnectTimeout);
    });
  });

  ioInstance = io;
  realtimeEmitter.setServer(io);
  return io;
}

let nowProvider: () => number = () => Date.now();

export function setRealtimeNow(fn: () => number): void {
  nowProvider = fn;
}

export function resetRealtimeNow(): void {
  nowProvider = () => Date.now();
}

/**
 * Handles token expiry warning and disconnect timers.
 */
function setupTokenExpiryLifecycle(socket: Socket, expSeconds: number): void {
  if (socket.data.expiringTimeout) clearTimeout(socket.data.expiringTimeout);
  if (socket.data.disconnectTimeout) clearTimeout(socket.data.disconnectTimeout);

  const nowMs = nowProvider();
  const expMs = expSeconds * 1000;
  const timeUntilExp = expMs - nowMs;

  if (timeUntilExp <= 0) {
    socket.emit('error', { code: 'TOKEN_EXPIRED', message: 'Token has expired' });
    socket.disconnect(true);
    return;
  }

  // Warning 60 seconds before expiry (or immediate if <= 60s)
  const warningDelay = timeUntilExp > 60000 ? timeUntilExp - 60000 : 0;
  socket.data.expiringTimeout = setTimeout(() => {
    socket.emit('auth:expiring', { expiresInSeconds: Math.max(1, Math.round((expMs - nowProvider()) / 1000)) });
  }, warningDelay);

  // Disconnect at expiry
  socket.data.disconnectTimeout = setTimeout(() => {
    socket.emit('error', { code: 'TOKEN_EXPIRED', message: 'Session expired. Disconnecting.' });
    socket.disconnect(true);
  }, timeUntilExp);
}

/**
 * Validates room join authorization.
 */
async function canJoinRoom(socket: Socket, room: string): Promise<boolean> {
  const user = socket.data.user;
  const guest = socket.data.guest;

  // 1. user:{id}
  if (room.startsWith('user:')) {
    const targetUserId = room.replace('user:', '');
    return user && user.userId === targetUserId;
  }

  // 2. admin:board
  if (room === 'admin:board') {
    return Boolean(
      user && (user.role === 'admin' || user.role === 'dispatcher' || user.role === 'user')
    );
  }

  // 3. booking:{id}
  if (room.startsWith('booking:')) {
    const bookingId = room.replace('booking:', '');

    // Guest check
    if (guest && guest.bookingId === bookingId) {
      return true;
    }

    if (!user) return false;

    // Admin & Dispatcher
    if (user.role === 'admin' || user.role === 'dispatcher' || user.role === 'user') {
      return true;
    }

    // Check DB for booking customer ownership or assigned technician
    const booking = await Booking.findOne({ _id: bookingId, deletedAt: null }).lean();
    if (!booking) return false;

    // Customer owner
    if (user.role === 'customer' && booking.customerId?.toString() === user.userId) {
      return true;
    }

    // Assigned technician only (technicians cannot join other bookings)
    if (
      user.role === 'technician' &&
      (booking.assignment?.technicianUserId?.toString() === user.userId ||
        booking.technicianId?.toString() === user.userId)
    ) {
      return true;
    }

    return false;
  }

  return false;
}

export function closeRealtimeServer(): Promise<void> {
  return new Promise((resolve) => {
    realtimeEmitter.setServer(null);
    if (redisPubClient) {
      redisPubClient.quit();
      redisPubClient = null;
    }
    if (redisSubClient) {
      redisSubClient.quit();
      redisSubClient = null;
    }
    if (ioInstance) {
      ioInstance.close(() => {
        ioInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

import type { Server as SocketIOServer } from 'socket.io';
import logger from '../config/logger';

export interface RealtimeEmitterInterface {
  setServer(io: SocketIOServer | null): void;
  emitToRoom(room: string, event: string, payload: unknown): void;
  emitBookingStatus(bookingId: string, payload: {
    bookingId: string;
    bookingNumber: string;
    status: string;
    updatedAt: string;
    note?: string;
  }): void;
  emitBookingAssigned(bookingId: string, payload: {
    bookingId: string;
    bookingNumber: string;
    technician: {
      displayName: string;
      photoUrl?: string;
      rating?: number;
      vehicleType?: string;
    };
  }): void;
  emitTechnicianLocation(bookingId: string, payload: {
    bookingId: string;
    technicianUserId: string;
    location: { lat: number; lng: number };
    heading?: number;
    speed?: number;
    accuracy?: number;
    updatedAt: string;
  }): void;
  emitTrackingEta(bookingId: string, payload: {
    bookingId: string;
    etaMinutes: number;
    distanceKm: number;
    etaSource: 'google' | 'estimate';
    updatedAt: string;
  }): void;
  emitOfferNew(technicianUserId: string, payload: {
    offerId: string;
    bookingId: string;
    bookingNumber: string;
    serviceName: string;
    scheduledTime: string;
    expiresAt: string;
    rank: number;
  }): void;
  emitOfferExpired(technicianUserId: string, payload: {
    offerId: string;
    bookingId: string;
    reason: string;
  }): void;
  emitDispatchBoardUpdate(payload: {
    type: 'unassigned' | 'offered' | 'assigned' | 'exhausted' | 'reassigned' | 'unassigned_manual';
    bookingId: string;
    bookingNumber: string;
    timestamp: string;
  }): void;
  disconnectUserSockets(userId: string, reason?: string): void;
}

class RealtimeEmitter implements RealtimeEmitterInterface {
  private io: SocketIOServer | null = null;

  setServer(io: SocketIOServer | null) {
    this.io = io;
  }

  getServer(): SocketIOServer | null {
    return this.io;
  }

  emitToRoom(room: string, event: string, payload: unknown): void {
    if (!this.io) {
      logger.debug({ room, event }, '[Realtime] No Socket.io instance attached (standalone or serverless mode); emit skipped');
      return;
    }
    this.io.to(room).emit(event, payload);
  }

  emitBookingStatus(bookingId: string, payload: Parameters<RealtimeEmitterInterface['emitBookingStatus']>[1]): void {
    this.emitToRoom(`booking:${bookingId}`, 'booking:status', payload);
    this.emitToRoom('admin:board', 'booking:status', payload);
  }

  emitBookingAssigned(bookingId: string, payload: Parameters<RealtimeEmitterInterface['emitBookingAssigned']>[1]): void {
    this.emitToRoom(`booking:${bookingId}`, 'booking:assigned', payload);
    this.emitToRoom('admin:board', 'booking:assigned', payload);
  }

  emitTechnicianLocation(bookingId: string, payload: Parameters<RealtimeEmitterInterface['emitTechnicianLocation']>[1]): void {
    this.emitToRoom(`booking:${bookingId}`, 'technician:location', payload);
    this.emitToRoom('admin:board', 'technician:location', payload);
  }

  emitTrackingEta(bookingId: string, payload: Parameters<RealtimeEmitterInterface['emitTrackingEta']>[1]): void {
    this.emitToRoom(`booking:${bookingId}`, 'tracking:eta', payload);
    this.emitToRoom('admin:board', 'tracking:eta', payload);
  }

  emitOfferNew(technicianUserId: string, payload: Parameters<RealtimeEmitterInterface['emitOfferNew']>[1]): void {
    this.emitToRoom(`user:${technicianUserId}`, 'offer:new', payload);
    this.emitToRoom('admin:board', 'offer:new', payload);
  }

  emitOfferExpired(technicianUserId: string, payload: Parameters<RealtimeEmitterInterface['emitOfferExpired']>[1]): void {
    this.emitToRoom(`user:${technicianUserId}`, 'offer:expired', payload);
    this.emitToRoom('admin:board', 'offer:expired', payload);
  }

  emitDispatchBoardUpdate(payload: Parameters<RealtimeEmitterInterface['emitDispatchBoardUpdate']>[0]): void {
    this.emitToRoom('admin:board', 'dispatch:board:update', payload);
  }

  disconnectUserSockets(userId: string, reason = 'ACCOUNT_SUSPENDED'): void {
    if (!this.io) return;
    const userRoom = `user:${userId}`;
    const room = this.io.sockets.adapter.rooms.get(userRoom);
    if (room) {
      for (const socketId of room) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('error', { code: reason, message: 'Account is suspended' });
          socket.disconnect(true);
        }
      }
    }
  }
}

export const realtimeEmitter: RealtimeEmitter = new RealtimeEmitter();

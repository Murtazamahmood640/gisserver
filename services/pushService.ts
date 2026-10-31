import logger from '../config/logger';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface IPushService {
  sendToUser(userId: string, payload: PushNotificationPayload): Promise<void>;
  sendToUsers(userIds: string[], payload: PushNotificationPayload): Promise<void>;
}

/**
 * No-op implementation for Prompt 5A (FCM push is out of scope).
 * Call sites exist and are wired cleanly; actual FCM integration can plug in later.
 */
class NoopPushService implements IPushService {
  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<void> {
    logger.debug({ userId, title: payload.title }, '[PushService] No-op push notification');
  }

  async sendToUsers(userIds: string[], payload: PushNotificationPayload): Promise<void> {
    logger.debug({ count: userIds.length, title: payload.title }, '[PushService] No-op bulk push notification');
  }
}

export const pushService: IPushService = new NoopPushService();

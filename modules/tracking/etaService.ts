import { haversineDistanceKm } from '../dispatch/matching';
import logger from '../../config/logger';

export interface EtaResult {
  distanceKm: number;
  etaMinutes: number;
  etaSource: 'google' | 'estimate';
}

interface CacheEntry {
  data: EtaResult;
  expiresAt: number;
}

const etaCache = new Map<string, CacheEntry>();

function getCacheKey(origin: [number, number], dest: [number, number]): string {
  // Round to 3 decimal places (~110m) for caching efficiency
  const oKey = `${origin[0].toFixed(3)},${origin[1].toFixed(3)}`;
  const dKey = `${dest[0].toFixed(3)},${dest[1].toFixed(3)}`;
  return `${oKey}->${dKey}`;
}

export class EtaService {
  /**
   * Calculates driving distance and ETA between origin [lng, lat] and destination [lng, lat].
   */
  static async calculateEta(
    origin: [number, number], // [lng, lat]
    destination: [number, number] // [lng, lat]
  ): Promise<EtaResult> {
    const cacheKey = getCacheKey(origin, destination);
    const cached = etaCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const googleKey = process.env.GOOGLE_MAPS_SERVER_KEY;
    if (googleKey && googleKey.trim()) {
      try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin[1]},${origin[0]}&destinations=${destination[1]},${destination[0]}&mode=driving&key=${googleKey}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          const json = (await res.json()) as {
            rows?: Array<{
              elements?: Array<{
                status: string;
                distance: { value: number };
                duration: { value: number };
              }>;
            }>;
          };
          const element = json?.rows?.[0]?.elements?.[0];
          if (element && element.status === 'OK') {
            const distanceMeters = element.distance.value;
            const durationSeconds = element.duration.value;

            const result: EtaResult = {
              distanceKm: Math.round((distanceMeters / 1000) * 10) / 10,
              etaMinutes: Math.max(1, Math.round(durationSeconds / 60)),
              etaSource: 'google',
            };

            etaCache.set(cacheKey, { data: result, expiresAt: now + 60 * 1000 });
            return result;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug({ err: msg }, '[EtaService] Google Distance Matrix call failed, falling back to estimate');
      }
    }

    // Haversine fallback with 1.4 road factor at 30 km/h average urban speed
    const directKm = haversineDistanceKm(origin, destination);
    const roadKm = Math.round(directKm * 1.4 * 10) / 10;
    const etaMinutes = Math.max(1, Math.round((roadKm / 30) * 60));

    const result: EtaResult = {
      distanceKm: roadKm,
      etaMinutes,
      etaSource: 'estimate',
    };

    etaCache.set(cacheKey, { data: result, expiresAt: now + 60 * 1000 });
    return result;
  }
}

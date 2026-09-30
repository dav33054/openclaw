// Tlon chat identity helpers accept only authenticated direct-message peers.
import { normalizeShip } from "../targets.js";

export function extractAuthenticatedDmPartnerShip(whom: unknown): string {
  const raw =
    typeof whom === "string"
      ? whom
      : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string"
        ? whom.ship
        : "";
  const normalized = normalizeShip(raw);
  return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
}

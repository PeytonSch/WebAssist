import type { RegistryType } from '../../shared/registry';
import { mavenKind } from './maven';
import { nexus3Kind } from './nexus3';
import type { RegistryKind } from './types';
import { urlKind } from './url';

/** Every kind of registry the hub can read. See types.ts for what adding one takes. */
export const KINDS: Record<RegistryType, RegistryKind> = {
  maven: mavenKind,
  nexus3: nexus3Kind,
  url: urlKind,
};

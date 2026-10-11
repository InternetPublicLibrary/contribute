import { AppError } from '../errors';
import { githubProvider } from './github';
import { type IdentityProvider, PROVIDERS, type ProviderDeps, type ProviderId } from './identity';
import { orcidProvider } from './orcid';

const REGISTRY: Record<ProviderId, (deps: ProviderDeps) => IdentityProvider> = {
  github: githubProvider,
  orcid: orcidProvider,
};

export function providerFor(id: string, deps: ProviderDeps): IdentityProvider {
  if (!(PROVIDERS as readonly string[]).includes(id)) throw new AppError('NOT_FOUND', `Unknown sign-in provider: ${id}.`);
  return REGISTRY[id as ProviderId](deps);
}

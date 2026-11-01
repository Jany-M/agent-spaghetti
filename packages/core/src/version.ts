// This package's version, sent to ACP agents as clientInfo.version (some, e.g. Kilo, reject initialize without it).
// A JSON import (not a runtime file read) so it resolves from src/ and inside any esbuild bundle.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

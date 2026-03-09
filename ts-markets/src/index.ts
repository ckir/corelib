// =============================================
// FILE: ts-markets/src/index.ts
// PURPOSE: Optional package (ts-markets)
// Can be imported separately: import { Markets } from '@ckir/corelib-markets'
// =============================================

import { ApiNasdaqUnlimited } from "./nasdaq/ApiNasdaqUnlimited";

export { ApiNasdaqUnlimited };

export const Markets = {
	nasdaq: ApiNasdaqUnlimited,
};

// =============================================
// FILE: ts-markets/src/index.ts
// PURPOSE: Optional package (ts-markets)
// Can be imported separately: import { Markets } from '@ckir/corelib-markets'
// =============================================

import {
	ApiNasdaqUnlimited,
	type NasdaqResult,
} from "./nasdaq/ApiNasdaqUnlimited";

export { ApiNasdaqUnlimited, type NasdaqResult };

export const Markets = {
	nasdaq: { ApiNasdaqUnlimited },
};

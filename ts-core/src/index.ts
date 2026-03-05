// =============================================
// FILE: ts-core/src/index.ts
// PURPOSE: Main public barrel export
// Now uses import * as + explicit re-export so CoreLib shorthand works
// Example usage:
// import { Core, Logger, CoreLib } from '@ckir/corelib'
// =============================================

import * as Cli from "./cli";
import * as Configs from "./configs";
import * as Core from "./core";
import * as Database from "./database";
import * as Logger from "./loggers";
import * as Retrieve from "./retrieve";
import * as Utils from "./utils";

export { Cli, Configs, Logger, Core, Database, Retrieve, Utils };

export const CoreLib = {
	Cli,
	Configs,
	Logger,
	Core,
	Database,
	Retrieve,
	Utils,
};

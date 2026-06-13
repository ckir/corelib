import { Command } from "commander";

async function run() {
  const program = new Command();
  program.exitOverride();
  program.allowUnknownOption(true);
  program.allowExcessArguments(true);
  program.helpOption(false);
  program.option("-C, --config <path>", "external config file or URL");

  const argv = ["--flag", "value", "--flag2=value2", "some-operand"];
  try {
    await program.parseAsync(argv, { from: "user" });
    console.log("SUCCESS");
    console.log("args:", program.args);
    console.log("opts:", program.opts());
  } catch (err) {
    console.error("ERROR:", err);
  }
}

run();

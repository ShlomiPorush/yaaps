#!/usr/bin/env node

import { createProgram, escapeDraftIdOperands } from "./program.js";

const program = createProgram();
await program.parseAsync(escapeDraftIdOperands(program, process.argv.slice(2)), {
  from: "user",
});

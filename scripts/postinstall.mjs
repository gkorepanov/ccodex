if (["1", "true"].includes(process.env.npm_config_global ?? "")) {
  try {
    const { repairManagedCcodexShim } = await import("../dist/management/shims.js");
    if (repairManagedCcodexShim() === "modified") {
      process.stderr.write("CCodex preserved a modified ~/.ccodex/bin/ccodex launcher; run the global ccodex executable directly to repair it.\n");
    }
  } catch (error) {
    process.stderr.write(`CCodex could not refresh its managed launcher: ${String(error)}\n`);
  }
}

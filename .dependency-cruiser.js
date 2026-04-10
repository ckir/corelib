/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    }
  ],

  options: {
    // ← This is the important fix
    tsConfig: {
      fileName: "./tsconfig.base.json"
    },

    doNotFollow: {
      path: "node_modules"
    },

    exclude: {
      path: [
        "dist",
        "docs",
        "target",
        "node_modules",
        "\\.test\\.(ts|tsx)$",
        "\\.spec\\.(ts|tsx)$",
        "\\.config\\.(ts|js)$"
      ]
    },

    // Better layout for large graphs
    reporterOptions: {
      dot: {
        theme: {
          graph: { rankdir: "LR" }   // Left to Right layout
        }
      }
    }
  }
};

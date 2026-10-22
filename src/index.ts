import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { fileURLToPath } from 'url';

// Create an MCP server
const server = new McpServer({
  name: "AfterEffectsServer",
  version: "1.0.0"
});

// ES Modules replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const SCRIPTS_DIR = path.join(__dirname, "scripts");
const TEMP_DIR = path.join(__dirname, "temp");

// Get all possible directories for AE bridge files
// Searches Public folder, user Documents, and OneDrive Documents to ensure
// compatibility regardless of Windows locale, OneDrive redirection, or custom setups.
function getAllAETempDirs(): string[] {
  const dirs: string[] = [];
  
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'ae-mcp-bridge'));
    dirs.push(path.join(os.homedir(), 'Documents', 'ae-mcp-bridge'));

    const oneDriveRoots = [
      process.env.OneDrive,
      process.env.OneDriveConsumer,
      process.env.OneDriveCommercial,
      path.join(os.homedir(), 'OneDrive')
    ].filter(Boolean) as string[];

    for (const od of oneDriveRoots) {
      if (fs.existsSync(od)) {
        try {
          const entries = fs.readdirSync(od, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              dirs.push(path.join(od, entry.name, 'ae-mcp-bridge'));
            }
          }
        } catch {}
      }
    }
  } else {
    dirs.push(path.join('/tmp', 'ae-mcp-bridge'));
    dirs.push(path.join(os.homedir(), 'Documents', 'ae-mcp-bridge'));
  }

  // Ensure directories exist where parent exists
  for (const dir of dirs) {
    try {
      const parent = path.dirname(dir);
      if (fs.existsSync(parent) && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {}
  }

  return [...new Set(dirs)].filter(d => fs.existsSync(d));
}

function getAETempDir(): string {
  const dirs = getAllAETempDirs();
  return dirs[0] || path.join(process.platform === 'win32' ? (process.env.PUBLIC || 'C:\\Users\\Public') : '/tmp', 'ae-mcp-bridge');
}

// Helper function to read results from After Effects temp file
function readResultsFromTempFile(): string {
  try {
    const dirs = getAllAETempDirs();
    let bestFile: string | null = null;
    let bestMtime = 0;

    for (const dir of dirs) {
      const testPath = path.join(dir, 'ae_mcp_result.json');
      if (fs.existsSync(testPath)) {
        const stats = fs.statSync(testPath);
        if (stats.mtimeMs > bestMtime) {
          bestMtime = stats.mtimeMs;
          bestFile = testPath;
        }
      }
    }

    if (bestFile) {
      const stats = fs.statSync(bestFile);
      const content = fs.readFileSync(bestFile, 'utf8');
      
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      if (stats.mtime < thirtySecondsAgo) {
        return JSON.stringify({ 
          warning: "Result file appears to be stale (not recently updated).",
          message: "This could indicate After Effects is not properly writing results or the MCP Bridge Auto panel isn't running.",
          lastModified: stats.mtime.toISOString(),
          originalContent: content
        });
      }
      return content;
    } else {
      return JSON.stringify({ error: "No results file found. Please run a script in After Effects first." });
    }
  } catch (error) {
    console.error("Error reading results file:", error);
    return JSON.stringify({ error: `Failed to read results: ${String(error)}` });
  }
}

// Helper to wait for a fresh result produced by a specific command
async function waitForBridgeResult(expectedCommand?: string, timeoutMs: number = 8000, pollMs: number = 250): Promise<string> {
  const start = Date.now();
  const dirs = getAllAETempDirs();

  while (Date.now() - start < timeoutMs) {
    for (const dir of dirs) {
      const resultPath = path.join(dir, 'ae_mcp_result.json');
      if (fs.existsSync(resultPath)) {
        try {
          const stats = fs.statSync(resultPath);
          if (stats.mtimeMs >= start - 1000) {
            const content = fs.readFileSync(resultPath, 'utf8');
            if (content && content.length > 0) {
              try {
                const parsed = JSON.parse(content);
                if (parsed.status !== "waiting" && (!expectedCommand || parsed._commandExecuted === expectedCommand)) {
                  return content;
                }
              } catch {}
            }
          }
        } catch {}
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return JSON.stringify({ error: `Timed out waiting for bridge result${expectedCommand ? ` for command '${expectedCommand}'` : ''}.` });
}

// Helper function to write command to file
function writeCommandFile(command: string, args: Record<string, any> = {}): void {
  try {
    const dirs = getAllAETempDirs();
    const commandData = {
      command,
      args,
      timestamp: new Date().toISOString(),
      status: "pending"  // pending, running, completed, error
    };
    const content = JSON.stringify(commandData, null, 2);

    for (const dir of dirs) {
      try {
        const commandFile = path.join(dir, 'ae_command.json');
        fs.writeFileSync(commandFile, content);
        console.error(`Command "${command}" written to ${commandFile}`);
      } catch (err) {
        console.error(`Failed to write command to ${dir}:`, err);
      }
    }
  } catch (error) {
    console.error("Error writing command file:", error);
  }
}

// Helper function to clear the results file to avoid stale cache
function clearResultsFile(): void {
  try {
    const dirs = getAllAETempDirs();
    const resetData = {
      status: "waiting",
      message: "Waiting for new result from After Effects...",
      timestamp: new Date().toISOString()
    };
    const content = JSON.stringify(resetData, null, 2);

    for (const dir of dirs) {
      try {
        const resultFile = path.join(dir, 'ae_mcp_result.json');
        fs.writeFileSync(resultFile, content);
      } catch {}
    }
  } catch (error) {
    console.error("Error clearing results file:", error);
  }
}

// Add a resource to expose project compositions
server.resource(
  "compositions",
  "aftereffects://compositions",
  async (uri) => {
    // Clear old results, queue the command, and wait for bridge output
    clearResultsFile();
    writeCommandFile("listCompositions", {});
    const result = await waitForBridgeResult("listCompositions", 6000, 250);

    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: result
      }]
    };
  }
);

// Add a tool for running read-only scripts
server.tool(
  "run-script",
  "Run a read-only script in After Effects",
  {
    script: z.string().describe("Name of the predefined script to run"),
    parameters: z.record(z.string(), z.unknown()).optional().describe("Optional parameters for the script")
  },
  async ({ script, parameters = {} }) => {
    // Validate that script is safe (only allow predefined scripts)
    const allowedScripts = [
      "listCompositions", 
      "getProjectInfo", 
      "getLayerInfo", 
      "createComposition",
      "createTextLayer",
      "createShapeLayer",
      "createSolidLayer",
      "setLayerProperties",
      "setLayerKeyframe",
      "setLayerExpression",
      "applyEffect",
      "applyEffectTemplate",
      "test-animation",
      "bridgeTestEffects",
      "createCamera",
      "batchSetLayerProperties",
      "setCompositionProperties",
      "duplicateLayer",
      "deleteLayer",
      "setLayerMask",
      "setKeyframeEase",
      "importFootage",
      "setupCameraRig",
      "replaceTextInComp",
      "replaceFootage",
      "listProjectItems"
    ];
    
    if (!allowedScripts.includes(script)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Script "${script}" is not allowed. Allowed scripts are: ${allowedScripts.join(", ")}`
          }
        ],
        isError: true
      };
    }

    try {
      // Clear any stale result data
      clearResultsFile();
      
      // Write command to file for After Effects to pick up
      writeCommandFile(script, parameters);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to run "${script}" has been queued.\n` +
                  `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
                  `Use the "get-results" tool after a few seconds to check for results.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add a tool to get the results from the last script execution
server.tool(
  "get-results",
  "Get results from the last script executed in After Effects",
  {},
  async () => {
    try {
      const result = readResultsFromTempFile();
      return {
        content: [
          {
            type: "text",
            text: result
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting results: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add prompts for common After Effects tasks
server.prompt(
  "list-compositions",
  "List compositions in the current After Effects project",
  () => {
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Please list all compositions in the current After Effects project."
        }
      }]
    };
  }
);

server.prompt(
  "analyze-composition",
  {
    compositionName: z.string().describe("Name of the composition to analyze")
  },
  (args) => {
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please analyze the composition named "${args.compositionName}" in the current After Effects project. Provide details about its duration, frame rate, resolution, and layers.`
        }
      }]
    };
  }
);

// Add a prompt for creating compositions
server.prompt(
  "create-composition",
  "Create a new composition with specified settings",
  () => {
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please create a new composition with custom settings. You can specify parameters like name, width, height, frame rate, etc.`
        }
      }]
    };
  }
);

// Add a tool to provide help and instructions
server.tool(
  "get-help",
  "Get help on using the After Effects MCP integration",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: `# After Effects MCP Integration Help

To use this integration with After Effects, follow these steps:

 1. **Install the scripts in After Effects**
   - Run \`node install-bridge.js\` with administrator privileges
   - This copies the necessary scripts to your After Effects installation

2. **Open After Effects**
   - Launch Adobe After Effects 
   - Open a project that you want to work with

3. **Open the MCP Bridge Auto panel**
   - In After Effects, go to Window > mcp-bridge-auto.jsx
   - The panel will automatically check for commands every few seconds

4. **Run scripts through MCP**
   - Use the \`run-script\` tool to queue a command
   - The Auto panel will detect and run the command automatically
   - Results will be saved to a temp file

5. **Get results through MCP**
   - After a command is executed, use the \`get-results\` tool
   - This will retrieve the results from After Effects

Available scripts:
- getProjectInfo: Information about the current project
- listCompositions: List all compositions in the project
- getLayerInfo: Information about layers in the active composition
- createComposition: Create a new composition
- createTextLayer: Create a new text layer
- createShapeLayer: Create a new shape layer
- createSolidLayer: Create a new solid layer
- setLayerProperties: Set properties for a layer
- setLayerKeyframe: Set a keyframe for a layer property
- setLayerExpression: Set an expression for a layer property
- applyEffect: Apply an effect to a layer
- applyEffectTemplate: Apply a predefined effect template to a layer

Effect Templates:
- gaussian-blur: Simple Gaussian blur effect
- directional-blur: Motion blur in a specific direction
- color-balance: Adjust hue, lightness, and saturation
- brightness-contrast: Basic brightness and contrast adjustment
- curves: Advanced color adjustment using curves
- glow: Add a glow effect to elements
- drop-shadow: Add a customizable drop shadow
- cinematic-look: Combination of effects for a cinematic appearance
- text-pop: Effects to make text stand out (glow and shadow)

Note: The auto-running panel can be left open in After Effects to continuously listen for commands from external applications.`
        }
      ]
    };
  }
);

// Add a tool specifically for creating compositions
server.tool(
  "create-composition",
  "Create a new composition in After Effects with specified parameters",
  {
    name: z.string().describe("Name of the composition"),
    width: z.number().int().positive().describe("Width of the composition in pixels"),
    height: z.number().int().positive().describe("Height of the composition in pixels"),
    pixelAspect: z.number().positive().optional().describe("Pixel aspect ratio (default: 1.0)"),
    duration: z.number().positive().optional().describe("Duration in seconds (default: 10.0)"),
    frameRate: z.number().positive().optional().describe("Frame rate in frames per second (default: 30.0)"),
    backgroundColor: z.object({
      r: z.number().int().min(0).max(255),
      g: z.number().int().min(0).max(255),
      b: z.number().int().min(0).max(255)
    }).optional().describe("Background color of the composition (RGB values 0-255)")
  },
  async (params) => {
    try {
      // Write command to file for After Effects to pick up
      writeCommandFile("createComposition", params);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to create composition "${params.name}" has been queued.\n` +
                  `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
                  `Use the "get-results" tool after a few seconds to check for results.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing composition creation: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// --- BEGIN NEW TOOLS --- 

// Zod schema for common layer identification
const LayerIdentifierSchema = {
  compIndex: z.number().int().positive().describe("1-based index of the target composition in the project panel."),
  layerIndex: z.number().int().positive().describe("1-based index of the target layer within the composition.")
};

// Zod schema for keyframe value (more specific types might be needed depending on property)
// Using z.any() for flexibility, but can be refined (e.g., z.array(z.number()) for position/scale)
const KeyframeValueSchema = z.unknown().describe("The value for the keyframe (e.g., [x,y] for Position, [w,h] for Scale, angle for Rotation, percentage for Opacity)");

// Tool for setting a layer keyframe
server.tool(
  "setLayerKeyframe", // Corresponds to the function name in ExtendScript
  "Set a keyframe for a specific layer property at a given time.",
  {
    ...LayerIdentifierSchema, // Reuse common identifiers
    propertyName: z.string().describe("Name of the property to keyframe (e.g., 'Position', 'Scale', 'Rotation', 'Opacity')."),
    timeInSeconds: z.number().describe("The time (in seconds) for the keyframe."),
    value: KeyframeValueSchema,
    ease: z.union([
      z.enum(["easyEase", "easyEaseIn", "easyEaseOut", "fastEase", "snappy", "smooth", "cinematic", "linear", "hold"]),
      z.object({
        easeType: z.string().optional(),
        speedIn: z.number().optional(),
        influenceIn: z.number().optional(),
        speedOut: z.number().optional(),
        influenceOut: z.number().optional()
      })
    ]).optional().describe("Optional easing to apply to the newly created keyframe (e.g. 'snappy', 'easyEase', or custom influence)")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("setLayerKeyframe", parameters);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to set keyframe for "${parameters.propertyName}" on layer ${parameters.layerIndex} in comp ${parameters.compIndex} has been queued.\n` +
                  `Use the "get-results" tool after a few seconds to check for confirmation.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing setLayerKeyframe command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool for setting a layer expression
server.tool(
  "setLayerExpression", // Corresponds to the function name in ExtendScript
  "Set or remove an expression for a specific layer property.",
  {
    ...LayerIdentifierSchema, // Reuse common identifiers
    propertyName: z.string().describe("Name of the property to apply the expression to (e.g., 'Position', 'Scale', 'Rotation', 'Opacity')."),
    expressionString: z.string().describe("The JavaScript expression string. Provide an empty string (\"\") to remove the expression.")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("setLayerExpression", parameters);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to set expression for "${parameters.propertyName}" on layer ${parameters.layerIndex} in comp ${parameters.compIndex} has been queued.\n` +
                  `Use the "get-results" tool after a few seconds to check for confirmation.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing setLayerExpression command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Tool for applying ease to keyframes
server.tool(
  "setKeyframeEase",
  "Apply ease (Easy Ease, Snappy, Smooth, or custom speed & influence) to keyframes of a property in After Effects",
  {
    compIndex: z.number().int().positive().optional().describe("1-based index of composition (defaults to active comp)"),
    layerIndex: z.number().int().positive().describe("1-based index of target layer within composition"),
    propertyName: z.string().describe("Property name (e.g. 'Position', 'Scale', 'Rotation', 'Opacity')"),
    keyIndex: z.number().int().positive().optional().describe("1-based index of keyframe to ease (omit to ease all keyframes)"),
    timeInSeconds: z.number().optional().describe("Time of keyframe in seconds (alternative to keyIndex)"),
    easeType: z.enum(["easyEase", "easyEaseIn", "easyEaseOut", "fastEase", "snappy", "smooth", "cinematic", "linear", "hold"]).optional().describe("Preset ease type"),
    speedIn: z.number().optional().describe("Incoming velocity (speed)"),
    influenceIn: z.number().min(0.1).max(100).optional().describe("Incoming influence % (e.g. 33.33 for standard ease, 75 for snappy modern pop)"),
    speedOut: z.number().optional().describe("Outgoing velocity (speed)"),
    influenceOut: z.number().min(0.1).max(100).optional().describe("Outgoing influence % (e.g. 33.33 for standard ease, 75 for snappy modern pop)")
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setKeyframeEase", parameters);
      const result = await waitForBridgeResult("setKeyframeEase", 8000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error executing setKeyframeEase: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// Tool for importing footage into project and composition
server.tool(
  "importFootage",
  "Import footage (image, video, audio, or sequence) from disk into After Effects and optionally add it to a composition",
  {
    filePath: z.string().describe("Absolute file path to media (PNG, JPG, MP4, MP3, WAV, PSD, AI, etc.)"),
    compIndex: z.number().int().positive().optional().describe("1-based index of target composition to add footage as layer"),
    compName: z.string().optional().describe("Target composition name"),
    startTime: z.number().optional().describe("Start time in seconds for the created layer"),
    duration: z.number().optional().describe("Duration in seconds for the created layer"),
    position: z.array(z.number()).optional().describe("Position [x, y] in comp"),
    scale: z.array(z.number()).optional().describe("Scale [sx, sy] percentage (e.g. [100, 100])"),
    threeDLayer: z.boolean().optional().describe("Enable 3D on the layer"),
    sequence: z.boolean().optional().describe("Import as image sequence"),
    name: z.string().optional().describe("Custom layer name")
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("importFootage", parameters);
      const result = await waitForBridgeResult("importFootage", 10000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error importing footage: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// Tool for setting up 3D Camera Rig with Null Orbit Controller
server.tool(
  "setupCameraRig",
  "Create a professional 3D Camera Rig with a 3D Null orbit controller, zoom, distance, and optional 3D enablement",
  {
    compIndex: z.number().int().positive().optional().describe("Composition index (defaults to active comp)"),
    compName: z.string().optional().describe("Composition name"),
    rigName: z.string().optional().describe("Name of the 3D Null controller (default: 'Camera Orbit Rig')"),
    cameraName: z.string().optional().describe("Name of the Camera layer (default: 'Cinematic Camera')"),
    zoom: z.number().optional().describe("Camera lens zoom value in pixels (default ~1777 for 50mm)"),
    distance: z.number().optional().describe("Camera distance along Z-axis from center (default 1500)"),
    enable3DOnLayers: z.boolean().optional().describe("Automatically enable 3D switch on all other layers in comp")
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("setupCameraRig", parameters);
      const result = await waitForBridgeResult("setupCameraRig", 8000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting up camera rig: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// Tool for replacing text in compositions (template/MoGRT customization)
server.tool(
  "replaceTextInComp",
  "Find and replace text content across layers in a composition (ideal for customizing AE templates & MoGRTs)",
  {
    compIndex: z.number().int().positive().optional().describe("Composition index (defaults to active comp)"),
    compName: z.string().optional().describe("Composition name"),
    layerName: z.string().optional().describe("Specific text layer name to update"),
    layerIndex: z.number().int().positive().optional().describe("Specific layer index to update"),
    findText: z.string().optional().describe("Substring to search for and replace across text layers"),
    newText: z.string().describe("New text content to insert"),
    fontSize: z.number().optional().describe("Optional new font size"),
    color: z.array(z.number()).optional().describe("Optional new text color [r, g, b] with values 0-1")
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("replaceTextInComp", parameters);
      const result = await waitForBridgeResult("replaceTextInComp", 8000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error replacing text in comp: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// Tool for replacing footage files in the project
server.tool(
  "replaceFootage",
  "Replace an existing footage item or placeholder in the project with a new file from disk (essential for template customization)",
  {
    newFilePath: z.string().describe("Absolute path to replacement media file on disk"),
    footageId: z.number().int().optional().describe("Project item ID of footage to replace"),
    footageName: z.string().optional().describe("Name of footage item in project panel to replace (e.g. 'Logo Placeholder.png')")
  },
  async (parameters) => {
    try {
      clearResultsFile();
      writeCommandFile("replaceFootage", parameters);
      const result = await waitForBridgeResult("replaceFootage", 8000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error replacing footage: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// Tool for listing all items in the project panel
server.tool(
  "listProjectItems",
  "List all items in the project panel including compositions, footage files, solids, and folders with metadata",
  {},
  async () => {
    try {
      clearResultsFile();
      writeCommandFile("listProjectItems", {});
      const result = await waitForBridgeResult("listProjectItems", 8000, 250);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error listing project items: ${String(error)}` }],
        isError: true
      };
    }
  }
);

// --- END NEW TOOLS --- 

// --- BEGIN NEW TESTING TOOL --- 
// Add a special tool for directly testing the keyframe functionality
server.tool(
  "test-animation",
  "Test animation functionality in After Effects",
  {
    operation: z.enum(["keyframe", "expression"]).describe("The animation operation to test"),
    compIndex: z.number().int().positive().describe("Composition index (usually 1)"),
    layerIndex: z.number().int().positive().describe("Layer index (usually 1)")
  },
  async (params) => {
    try {
      // Generate a unique timestamp
      const timestamp = new Date().getTime();
      const tempFile = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), `ae_test_${timestamp}.jsx`);
      
      // Create a direct test script that doesn't rely on command files
      let scriptContent = "";
      if (params.operation === "keyframe") {
        scriptContent = `
          // Direct keyframe test script
          try {
            var comp = app.project.items[${params.compIndex}];
            var layer = comp.layers[${params.layerIndex}];
            var prop = layer.property("Transform").property("Opacity");
            var time = 1; // 1 second
            var value = 25; // 25% opacity
            
            // Set a keyframe
            prop.setValueAtTime(time, value);
            
            // Write direct result
            var resultFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'ae_test_result.txt').replace(/\\/g, '\\\\')}");
            resultFile.open("w");
            resultFile.write("SUCCESS: Added keyframe at time " + time + " with value " + value);
            resultFile.close();
            
            // Visual feedback
            alert("Test successful: Added opacity keyframe at " + time + "s with value " + value + "%");
          } catch (e) {
            var errorFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'ae_test_error.txt').replace(/\\/g, '\\\\')}");
            errorFile.open("w");
            errorFile.write("ERROR: " + e.toString());
            errorFile.close();
            
            alert("Test failed: " + e.toString());
          }
        `;
      } else if (params.operation === "expression") {
        scriptContent = `
          // Direct expression test script
          try {
            var comp = app.project.items[${params.compIndex}];
            var layer = comp.layers[${params.layerIndex}];
            var prop = layer.property("Transform").property("Position");
            var expression = "wiggle(3, 30)";
            
            // Set the expression
            prop.expression = expression;
            
            // Write direct result
            var resultFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'ae_test_result.txt').replace(/\\/g, '\\\\')}");
            resultFile.open("w");
            resultFile.write("SUCCESS: Added expression: " + expression);
            resultFile.close();
            
            // Visual feedback
            alert("Test successful: Added position expression: " + expression);
          } catch (e) {
            var errorFile = new File("${path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'ae_test_error.txt').replace(/\\/g, '\\\\')}");
            errorFile.open("w");
            errorFile.write("ERROR: " + e.toString());
            errorFile.close();
            
            alert("Test failed: " + e.toString());
          }
        `;
      }
      
      // Write the script to a temp file
      fs.writeFileSync(tempFile, scriptContent);
      console.error(`Written test script to: ${tempFile}`);
      
      // Tell the user what to do
      return {
        content: [
          {
            type: "text",
            text: `I've created a direct test script for the ${params.operation} operation.

Please run this script manually in After Effects:
1. In After Effects, go to File > Scripts > Run Script File...
2. Navigate to: ${tempFile}
3. You should see an alert confirming the result.

This bypasses the MCP Bridge Auto panel and will directly modify the specified layer.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating test script: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);
// --- END NEW TESTING TOOL --- 

// --- BEGIN NEW EFFECTS TOOLS ---

// Add a tool for applying effects to layers
server.tool(
  "apply-effect",
  "Apply an effect to a layer in After Effects",
  {
    compIndex: z.number().int().positive().describe("1-based index of the target composition in the project panel."),
    layerIndex: z.number().int().positive().describe("1-based index of the target layer within the composition."),
    effectName: z.string().optional().describe("Display name of the effect to apply (e.g., 'Gaussian Blur')."),
    effectMatchName: z.string().optional().describe("After Effects internal name for the effect (more reliable, e.g., 'ADBE Gaussian Blur 2')."),
    effectCategory: z.string().optional().describe("Optional category for filtering effects."),
    presetPath: z.string().optional().describe("Optional path to an effect preset file (.ffx)."),
    effectSettings: z.record(z.string(), z.unknown()).optional().describe("Optional parameters for the effect (e.g., { 'Blurriness': 25 }).")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffect", parameters);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to apply effect to layer ${parameters.layerIndex} in composition ${parameters.compIndex} has been queued.\n` +
                  `Use the "get-results" tool after a few seconds to check for confirmation.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing apply-effect command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add a tool for applying effect templates
server.tool(
  "apply-effect-template",
  "Apply a predefined effect template to a layer in After Effects",
  {
    compIndex: z.number().int().positive().describe("1-based index of the target composition in the project panel."),
    layerIndex: z.number().int().positive().describe("1-based index of the target layer within the composition."),
    templateName: z.enum([
      "gaussian-blur", 
      "directional-blur", 
      "color-balance", 
      "brightness-contrast",
      "curves",
      "glow",
      "drop-shadow",
      "cinematic-look",
      "text-pop"
    ]).describe("Name of the effect template to apply."),
    customSettings: z.record(z.string(), z.unknown()).optional().describe("Optional custom settings to override defaults.")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffectTemplate", parameters);
      
      return {
        content: [
          {
            type: "text",
            text: `Command to apply effect template '${parameters.templateName}' to layer ${parameters.layerIndex} in composition ${parameters.compIndex} has been queued.\n` +
                  `Use the "get-results" tool after a few seconds to check for confirmation.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing apply-effect-template command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// --- END NEW EFFECTS TOOLS ---

// Add direct MCP function for applying effects
server.tool(
  "mcp_aftereffects_applyEffect",
  "Apply an effect to a layer in After Effects",
  {
    compIndex: z.number().int().positive().describe("1-based index of the target composition in the project panel."),
    layerIndex: z.number().int().positive().describe("1-based index of the target layer within the composition."),
    effectName: z.string().optional().describe("Display name of the effect to apply (e.g., 'Gaussian Blur')."),
    effectMatchName: z.string().optional().describe("After Effects internal name for the effect (more reliable, e.g., 'ADBE Gaussian Blur 2')."),
    effectSettings: z.record(z.string(), z.unknown()).optional().describe("Optional parameters for the effect (e.g., { 'Blurriness': 25 }).")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffect", parameters);
      
      // Wait a bit for After Effects to process the command
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get the results
      const result = readResultsFromTempFile();
      
      return {
        content: [
          {
            type: "text",
            text: result
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying effect: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add direct MCP function for applying effect templates
server.tool(
  "mcp_aftereffects_applyEffectTemplate",
  "Apply a predefined effect template to a layer in After Effects",
  {
    compIndex: z.number().int().positive().describe("1-based index of the target composition in the project panel."),
    layerIndex: z.number().int().positive().describe("1-based index of the target layer within the composition."),
    templateName: z.enum([
      "gaussian-blur", 
      "directional-blur", 
      "color-balance", 
      "brightness-contrast",
      "curves",
      "glow",
      "drop-shadow",
      "cinematic-look",
      "text-pop"
    ]).describe("Name of the effect template to apply."),
    customSettings: z.record(z.string(), z.unknown()).optional().describe("Optional custom settings to override defaults.")
  },
  async (parameters) => {
    try {
      // Queue the command for After Effects
      writeCommandFile("applyEffectTemplate", parameters);
      
      // Wait a bit for After Effects to process the command
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get the results
      const result = readResultsFromTempFile();
      
      return {
        content: [
          {
            type: "text",
            text: result
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error applying effect template: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Update help information to include the new effects tools
server.tool(
  "mcp_aftereffects_get_effects_help",
  "Get help on using After Effects effects",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: `# After Effects Effects Help

## Common Effect Match Names
These are internal names used by After Effects that can be used with the \`effectMatchName\` parameter:

### Blur & Sharpen
- Gaussian Blur: "ADBE Gaussian Blur 2"
- Camera Lens Blur: "ADBE Camera Lens Blur"
- Directional Blur: "ADBE Directional Blur"
- Radial Blur: "ADBE Radial Blur"
- Smart Blur: "ADBE Smart Blur"
- Unsharp Mask: "ADBE Unsharp Mask"

### Color Correction
- Brightness & Contrast: "ADBE Brightness & Contrast 2"
- Color Balance: "ADBE Color Balance (HLS)"
- Color Balance (RGB): "ADBE Pro Levels2"
- Curves: "ADBE CurvesCustom"
- Exposure: "ADBE Exposure2"
- Hue/Saturation: "ADBE HUE SATURATION"
- Levels: "ADBE Pro Levels2"
- Vibrance: "ADBE Vibrance"

### Stylistic
- Glow: "ADBE Glow"
- Drop Shadow: "ADBE Drop Shadow"
- Bevel Alpha: "ADBE Bevel Alpha"
- Noise: "ADBE Noise"
- Fractal Noise: "ADBE Fractal Noise"
- CC Particle World: "CC Particle World"
- CC Light Sweep: "CC Light Sweep"

## Effect Templates
The following predefined effect templates are available:

- \`gaussian-blur\`: Simple Gaussian blur effect
- \`directional-blur\`: Motion blur in a specific direction
- \`color-balance\`: Adjust hue, lightness, and saturation
- \`brightness-contrast\`: Basic brightness and contrast adjustment
- \`curves\`: Advanced color adjustment using curves
- \`glow\`: Add a glow effect to elements
- \`drop-shadow\`: Add a customizable drop shadow
- \`cinematic-look\`: Combination of effects for a cinematic appearance
- \`text-pop\`: Effects to make text stand out (glow and shadow)

## Example Usage
To apply a Gaussian blur effect:

\`\`\`json
{
  "compIndex": 1,
  "layerIndex": 1,
  "effectMatchName": "ADBE Gaussian Blur 2",
  "effectSettings": {
    "Blurriness": 25
  }
}
\`\`\`

To apply the "cinematic-look" template:

\`\`\`json
{
  "compIndex": 1,
  "layerIndex": 1,
  "templateName": "cinematic-look"
}
\`\`\`
`
        }
      ]
    };
  }
);

// Add a direct tool for our bridge test effects
server.tool(
  "run-bridge-test",
  "Run the bridge test effects script to verify communication and apply test effects",
  {},
  async () => {
    try {
      // Clear any stale result data
      clearResultsFile();
      
      // Write command to file for After Effects to pick up
      writeCommandFile("bridgeTestEffects", {});
      
      return {
        content: [
          {
            type: "text",
            text: `Bridge test effects command has been queued.\n` +
                  `Please ensure the "MCP Bridge Auto" panel is open in After Effects.\n` +
                  `Use the "get-results" tool after a few seconds to check for the test results.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error queuing bridge test command: ${String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

// Start the MCP server
async function main() {
  console.error("After Effects MCP Server starting...");
  console.error(`Scripts directory: ${SCRIPTS_DIR}`);
  console.error(`Temp directory: ${TEMP_DIR}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("After Effects MCP Server running...");
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});

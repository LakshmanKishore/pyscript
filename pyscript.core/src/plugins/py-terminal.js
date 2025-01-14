// PyScript py-terminal plugin
import { TYPES, hooks } from "../core.js";

const CDN = "https://cdn.jsdelivr.net/npm/xterm";
const XTERM = "5.3.0";
const XTERM_READLINE = "1.1.1";
const SELECTOR = [...TYPES.keys()]
    .map((type) => `script[type="${type}"][terminal],${type}-script[terminal]`)
    .join(",");

const pyTerminal = async () => {
    const terminals = document.querySelectorAll(SELECTOR);

    // no results will look further for runtime nodes
    if (!terminals.length) return;

    // we currently support only one terminal as in "classic"
    if (terminals.length > 1)
        console.warn("Unable to satisfy multiple terminals");

    // if we arrived this far, let's drop the MutationObserver
    mo.disconnect();

    const [element] = terminals;
    // hopefully to be removed in the near future!
    if (element.matches('script[type="mpy"],mpy-script'))
        throw new Error("Unsupported terminal");

    // import styles once and lazily (only on valid terminal)
    if (!document.querySelector(`link[href^="${CDN}"]`)) {
        document.head.append(
            Object.assign(document.createElement("link"), {
                rel: "stylesheet",
                href: `${CDN}@${XTERM}/css/xterm.min.css`,
            }),
        );
    }

    // lazy load these only when a valid terminal is found
    const [{ Terminal }, { Readline }] = await Promise.all([
        import(/* webpackIgnore: true */ `${CDN}@${XTERM}/+esm`),
        import(
            /* webpackIgnore: true */ `${CDN}-readline@${XTERM_READLINE}/+esm`
        ),
    ]);

    const readline = new Readline();

    // common main thread initialization for both worker
    // or main case, bootstrapping the terminal on its target
    const init = (options) => {
        let target = element;
        const selector = element.getAttribute("target");
        if (selector) {
            target =
                document.getElementById(selector) ||
                document.querySelector(selector);
            if (!target) throw new Error(`Unknown target ${selector}`);
        } else {
            target = document.createElement("py-terminal");
            target.style.display = "block";
            element.after(target);
        }
        const terminal = new Terminal({
            theme: {
                background: "#191A19",
                foreground: "#F5F2E7",
            },
            ...options,
        });
        terminal.loadAddon(readline);
        terminal.open(target);
        terminal.focus();
    };

    // branch logic for the worker
    if (element.hasAttribute("worker")) {
        // when the remote thread onReady triggers:
        // setup the interpreter stdout and stderr
        const workerReady = ({ interpreter }, { sync }) => {
            sync.pyterminal_drop_hooks();
            const decoder = new TextDecoder();
            const generic = {
                isatty: true,
                write(buffer) {
                    sync.pyterminal_write(decoder.decode(buffer));
                    return buffer.length;
                },
            };
            interpreter.setStdout(generic);
            interpreter.setStderr(generic);
        };

        // run in python code able to replace builtins.input
        // using the xworker.sync non blocking prompt
        const codeBefore = `
            import builtins
            from pyscript import sync as _sync

            builtins.input = lambda prompt: _sync.pyterminal_read(prompt)
        `;

        // at the end of the code, make the terminal interactive
        const codeAfter = `
            import code as _code
            _code.interact()
        `;

        // add a hook on the main thread to setup all sync helpers
        // also bootstrapping the XTerm target on main
        hooks.main.onWorker.add(function worker(_, xworker) {
            hooks.main.onWorker.delete(worker);
            init({
                disableStdin: false,
                cursorBlink: true,
                cursorStyle: "block",
            });
            xworker.sync.pyterminal_read = readline.read.bind(readline);
            xworker.sync.pyterminal_write = readline.write.bind(readline);
            // allow a worker to drop main thread hooks ASAP
            xworker.sync.pyterminal_drop_hooks = () => {
                hooks.worker.onReady.delete(workerReady);
                hooks.worker.codeBeforeRun.delete(codeBefore);
                hooks.worker.codeAfterRun.delete(codeAfter);
            };
        });

        // setup remote thread JS/Python code for whenever the
        // worker is ready to become a terminal
        hooks.worker.onReady.add(workerReady);
        hooks.worker.codeBeforeRun.add(codeBefore);
        hooks.worker.codeAfterRun.add(codeAfter);
    } else {
        // in the main case, just bootstrap XTerm without
        // allowing any input as that's not possible / awkward
        hooks.main.onReady.add(function main({ io }) {
            console.warn("py-terminal is read only on main thread");
            hooks.main.onReady.delete(main);
            init({
                disableStdin: true,
                cursorBlink: false,
                cursorStyle: "underline",
            });
            io.stdout = (value) => {
                readline.write(`${value}\n`);
            };
            io.stderr = (error) => {
                readline.write(`${error.message || error}\n`);
            };
        });
    }
};

const mo = new MutationObserver(pyTerminal);
mo.observe(document, { childList: true, subtree: true });

// try to check the current document ASAP
export default pyTerminal();

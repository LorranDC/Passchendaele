import { useEffect, useMemo, useRef, useState } from "react";
import type { HudState, Weapon } from "./game/types";
import "./App.css";

type RuntimeHandle = {
  startGame: () => void;
  restartGame: () => void;
  swapWeapon: () => void;
  setWeapon: (next: Weapon) => void;
  setTankModelFile: (fileName: string) => void;
  getTankModelFile: () => string;
  dispose: () => void;
};

type TankOption = {
  value: string;
  label: string;
};

const MODELS_MANIFEST_URL = "/models/models.json";

const formatTankLabel = (fileName: string): string =>
  fileName
    .replace(/\.glb$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const initialHud: HudState = {
  hp: 100,
  score: 0,
  weapon: "cannon",
  cannonAmmo: 6,
  mgAmmo: 200,
  running: false,
  gameOver: false,
  hint: "V - 1a pessoa | W/S mover | A/D girar | Mouse mirar | Clique atirar | TAB trocar arma | R reparar",
  crosshairX: window.innerWidth / 2,
  crosshairY: window.innerHeight / 2,
};

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<RuntimeHandle | null>(null);
  const [hud, setHud] = useState<HudState>(initialHud);
  const [loadingRuntime, setLoadingRuntime] = useState(false);
  const [selectedTankModel, setSelectedTankModel] = useState("");
  const [tankOptions, setTankOptions] = useState<TankOption[]>([]);

  useEffect(() => {
    return () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadModels = async () => {
      try {
        const res = await fetch(MODELS_MANIFEST_URL, { cache: "no-store" });
        if (!res.ok) return;

        const data = (await res.json()) as { models?: string[] };
        const models = (data.models ?? [])
          .filter((name) => name.toLowerCase().endsWith(".glb"))
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

        if (!active || models.length === 0) return;

        const nextOptions = models.map((value) => ({
          value,
          label: formatTankLabel(value),
        }));

        setTankOptions(nextOptions);
        setSelectedTankModel((current) =>
          current && models.includes(current) ? current : models[0],
        );
      } catch {
        // Keep current defaults if manifest is temporarily unavailable.
      }
    };

    void loadModels();
    const intervalId = window.setInterval(() => {
      void loadModels();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const hpPct = useMemo(() => Math.max(0, Math.min(100, hud.hp)), [hud.hp]);

  const ensureRuntime = async (): Promise<RuntimeHandle | null> => {
    if (runtimeRef.current) return runtimeRef.current;
    if (loadingRuntime) return null;

    const canvas = canvasRef.current;
    if (!canvas) return null;

    setLoadingRuntime(true);
    try {
      const mod = await import("./game/runtime");
      const runtime = new mod.GameRuntime({
        canvas,
        onHud: setHud,
      });
      if (selectedTankModel) {
        runtime.setTankModelFile(selectedTankModel);
      }
      setSelectedTankModel(runtime.getTankModelFile());
      runtimeRef.current = runtime;
      return runtime;
    } finally {
      setLoadingRuntime(false);
    }
  };

  const onStart = async () => {
    const runtime = await ensureRuntime();
    runtime?.startGame();
  };

  const onRestart = () => {
    runtimeRef.current?.restartGame();
  };

  const onSwap = () => {
    runtimeRef.current?.swapWeapon();
  };

  const setWeapon = (next: Weapon) => {
    runtimeRef.current?.setWeapon(next);
  };

  const onTankModelChange = (fileName: string) => {
    setSelectedTankModel(fileName);
    runtimeRef.current?.setTankModelFile(fileName);
  };

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      <div
        className="crosshair"
        style={{ left: `${hud.crosshairX}px`, top: `${hud.crosshairY}px` }}
      />

      <div className="hud-panel">
        <h1>PASSCHENDAELE 1917</h1>
        <p className="hint">{hud.hint}</p>
        <div className="bars">
          <div className="hp-wrap">
            <span>Blindagem</span>
            <div className="hp-track">
              <div className="hp-fill" style={{ width: `${hpPct}%` }} />
            </div>
          </div>
          <div className="score">Inimigos destruídos: {hud.score}</div>
        </div>
        <div className="ammo-row">
          <button
            className={`weapon-btn ${hud.weapon === "cannon" ? "active" : ""}`}
            onClick={() => setWeapon("cannon")}
          >
            Canhão ({hud.cannonAmmo})
          </button>
          <button
            className={`weapon-btn ${hud.weapon === "mg" ? "active" : ""}`}
            onClick={() => setWeapon("mg")}
          >
            MG ({hud.mgAmmo})
          </button>
          <button className="weapon-btn" onClick={onSwap}>
            Trocar [TAB]
          </button>
        </div>
      </div>

      {!hud.running && !hud.gameOver ? (
        <div className="overlay">
          <div className="dialog">
            <h2>Pronto para avançar</h2>
            <p>
              Avance pelo lamaçal, mantenha a mira estável e sobreviva às ondas
              inimigas.
            </p>
            <div className="tank-row tank-row-overlay">
              <label htmlFor="tank-model-start" className="tank-label">
                Tanque
              </label>
              <select
                id="tank-model-start"
                className="tank-select"
                value={selectedTankModel}
                onChange={(e) => onTankModelChange(e.target.value)}
              >
                {tankOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="main-btn" onClick={onStart}>
              {loadingRuntime ? "Carregando..." : "Iniciar"}
            </button>
          </div>
        </div>
      ) : null}

      {hud.gameOver ? (
        <div className="overlay">
          <div className="dialog">
            <h2>Tanque Destruído</h2>
            <p>Inimigos destruídos: {hud.score}</p>
            <div className="tank-row tank-row-overlay">
              <label htmlFor="tank-model-restart" className="tank-label">
                Tanque
              </label>
              <select
                id="tank-model-restart"
                className="tank-select"
                value={selectedTankModel}
                onChange={(e) => onTankModelChange(e.target.value)}
              >
                {tankOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <button className="main-btn" onClick={onRestart}>
              Reiniciar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;

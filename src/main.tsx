import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
// Single consolidated stylesheet (base layer + Workshop design, cascade order
// preserved from the former aurora.css + workshop.css).
import "./styles/workshop.css";

createRoot(document.getElementById("root")!).render(<App />);

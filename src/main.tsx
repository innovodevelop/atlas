import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./styles/aurora.css";
// Workshop reskin loads AFTER aurora.css: shared class names resolve to the
// new warm-light design; aurora.css remains only for classes Workshop lacks.
import "./styles/workshop.css";

createRoot(document.getElementById("root")!).render(<App />);

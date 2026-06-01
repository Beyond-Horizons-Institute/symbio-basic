import "../index.css";
import { createRoot } from "react-dom/client";
import Overlay from "./Overlay";

const root = createRoot(document.getElementById("overlay-root")!);
root.render(<Overlay />);

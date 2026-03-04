import "./styles/base.css";

const links = document.querySelectorAll(".home-card");
for (const link of links) {
  link.addEventListener("mousemove", (event) => {
    const rect = link.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    link.style.setProperty("--mx", `${x}%`);
    link.style.setProperty("--my", `${y}%`);
  });
}

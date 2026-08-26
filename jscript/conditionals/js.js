const select = document.querySelector("select");
const para = document.querySelector("p");

select.addEventListener("change", setWeather);

function setWeather() {
	const choice = select.value;

	if (choice === "sunny") {
		para.textContent =
			"It is nice and sunny outside today. Wear shorts! Gotot the beach or the park, and get some ice crea,.";
	} else if (choice === "rainy") {
		para.textContent = 
			"Rain is falling outside; wear a rain coat and dont stay out too long.";
	} else if (choice === "snowing") {
		para.textContent = 
			"Just don't leave the house. Start a fire or somethin.";
	} else if (choice === "overcast") {
		para.textContent =
			"Be prepared. Winter is coming. Or just rain, who cares about that.";
	} else {
		para.textContent = "";
	}
}

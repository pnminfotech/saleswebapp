// utils/period.js
function pad2(n){ return String(n).padStart(2, "0"); }
function lastDayOfMonth(year, month1to12){
  return new Date(year, month1to12, 0).getDate(); // month=2 => last day feb
}
function toDateKey(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function getRange(periodType, periodKey){
  const pt = String(periodType || "").toUpperCase();

  if(pt === "MONTH"){
    const [y, m] = String(periodKey).split("-").map(Number);
    const ld = lastDayOfMonth(y, m);
    return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(ld)}` };
  }

  if(pt === "QUARTER"){
    const raw = String(periodKey || "").toUpperCase().trim();
    const fy = raw.match(/^FY(\d{4})-Q([1-4])$/);

    let fromD;
    let toD;

    if (fy) {
      // FY2026-Q1 => Apr-Jun 2026 ... FY2026-Q4 => Jan-Mar 2027
      const fyStart = Number(fy[1]);
      const q = Number(fy[2]);
      const startMonth = q === 1 ? 3 : q === 2 ? 6 : q === 3 ? 9 : 0;
      const startYear = q === 4 ? fyStart + 1 : fyStart;
      fromD = new Date(startYear, startMonth, 1);
      toD = new Date(startYear, startMonth + 3, 0);
    } else {
      // backward compatibility: 2026-Q1 (calendar quarter)
      const [yStr, qStr] = raw.split("-Q");
      const y = Number(yStr);
      const q = Number(qStr); // 1..4
      const startMonth = (q-1)*3; // 0,3,6,9
      fromD = new Date(y, startMonth, 1);
      toD = new Date(y, startMonth+3, 0); // last day of quarter
    }

    return { from: toDateKey(fromD), to: toDateKey(toD) };
  }

  if(pt === "YEAR"){
    const raw = String(periodKey || "").toUpperCase().trim();
    const fy = raw.match(/^FY(\d{4})$/);
    const cy = raw.match(/^CY(\d{4})$/);

    let fromD;
    let toD;
    if (fy) {
      const y = Number(fy[1]);
      fromD = new Date(y, 3, 1);      // Apr 1
      toD = new Date(y+1, 2, 31);     // Mar 31
    } else {
      const y = Number(cy ? cy[1] : raw);
      fromD = new Date(y, 0, 1);      // Jan 1
      toD = new Date(y, 11, 31);      // Dec 31
    }

    return { from: toDateKey(fromD), to: toDateKey(toD) };
  }

  throw new Error("Invalid periodType/periodKey");
}

module.exports = { getRange };



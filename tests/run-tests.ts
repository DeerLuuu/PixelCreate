import { finish } from "./common";
import { testHistory } from "./history.test";
import { testOps } from "./ops.test";

console.log("--- history ---");
testHistory();
console.log("--- ops ---");
testOps();
finish();
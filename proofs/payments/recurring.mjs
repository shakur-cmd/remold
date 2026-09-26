// Required P4 scope remains open: a one-charge permit cannot authorize an ongoing schedule.
export function recurring(){
 return{name:'Recurring activation, renewal, failed-payment retry, card update, cancellation and replacement',status:'BLOCKED',reason:'Standing recurring authority and provider retry-concurrency proof required; subscription creation and invoice/pay are refused by the collection adapter'};
}

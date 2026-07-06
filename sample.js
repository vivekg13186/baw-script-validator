/*This function converts an AddressWS object to an Address object. It takes an AddressWS object as input and returns a new Address object with the same properties.
* @param {AddressWS} addressWs - The AddressWS object to be converted.
* @returns {Address} - The converted Address object.
*/
function convertAddressWsToAddress(addressWs) {
    var result = new tw.object.Address();
    result.line1 = addressWs.line1;
    result.line2 = addressWs.line2;
    result.postcode = addressWs.postcode;
    result.type = addressWs.type;
    return result;  
}
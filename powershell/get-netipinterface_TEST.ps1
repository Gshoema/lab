Get-NetIPInterface | findstr Connected | findstr IPv4 
$intIndex = Read-Host -Prompt "Enter the interface number you wish to modify: "

Set-NetIPInterface -InterfaceIndex $intIndex -InterfaceMetric 1


*********2nd Option: On the secondary network interface, hard-code the IP settings without a DNS server.
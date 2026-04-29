# Check for Administrative Privileges and Elevate if Needed
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

# Your actual script commands go below this line
Write-Host "Script is running with administrative privileges." -ForegroundColor Green

#Set all interfaces metric to 15
Get-NetIPInterface | Set-NetIPInterface -InterfaceMetric 15

#Grab our needed interface
$index = (Get-NetIPAddress | Where-Object IPAddress -like '192.168.129.*').InterfaceIndex

#Elevate metric to priority
Set-NetIPInterface -InterfaceIndex $index -InterfaceMetric 5
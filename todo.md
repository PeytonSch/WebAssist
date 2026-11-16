Label log lines with the source of the log, that way I can easily see which tomcat logs come from which webapp. 

Add a start chrome with debug port button. 

tomcat logs are labeled as info when the message linese are all debug lines 

add some sort of syntax highlighting to the messages to make them easier to read 

when starting chrome with the suggested command in settings:
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=57017 --user-data-dir="%LOCALAPPDATA%\DebugHub\chrome-profile"

the application does not pick up any logs or network events. Confirmed with chrome://version/ that 

Google Chrome	157.0.8103.79 (Official Build) (64-bit) (cohort: Early Adopters) 
Revision	6dc9bc3bdaea5c35ed6d41fceab2f7a3a2227c4f-refs/branch-heads/8103@{#1574}
OS	Windows 11 Version 24H2 (Build 26100.9911)
JavaScript	V8 15.7.112.43
User Agent	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36
Command Line	"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=57017 --flag-switches-begin --flag-switches-end --origin-trial-disabled-features=CanvasTextNg|WebAssemblyCustomDescriptors
Executable Path	C:\Program Files\Google\Chrome\Application\chrome.exe
Profile Path	C:\Users\<my-user>\AppData\Local\Google\Chrome\User Data\Default

but application just says waiting for chromes debugging port. 

add in a tomcat managment page. I want to be able to start and stop tomcat webapps easily from within the application. Add the ability to designate a non-webapps folder that I can move "dissabled" webapps to. When dissabled move them out of the tomcat webapps dir and into the specified dir so that tomcat doesn't know about them. Add the ability for me to re-enable them by moving from that folder back to the webapps folder. Additionally add the ability to specify a tomcat start script or stop script to use to start and stop the tomcate app. I use custom scripts to startup or stop my tomcat server. 

add the ability to specify a tomcat logs folder so I can get every log from the folder, but then allow me to set filters to filter out any logs I from webapps I am not currently interested in. 

add some more padding to the keyboard shortcuts and toggle light / dark theme icons. 

add the ability to specify directories to watch for war files. These directories will be where I develop and build my webapps, and when I build a new war for a webapp I want the program to notify me that a new war is availible and give me the option to deploy it to tomcat. 





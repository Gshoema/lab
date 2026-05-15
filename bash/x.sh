#This is just a file of commands and bash tricks to effectively utilize linux better


#Prevents npm from installing dpendencies that were released less than 3 days ago.
npm config set min-release-age=3

#makes a 10GB file of all 0's. /dev/zero is an instant 0 generator. Also can be used to wipe a disk.
dd if=/dev/zero of=testzip bs=1 count=0 seek=10G

import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';

@Component({
	selector: 'jarvis-add-task',
	templateUrl: './add-task.component.html',
	styleUrls: ['./add-task.component.less']
})
export class AddTaskComponent implements OnInit {

	public form: FormGroup = this._formBuilder.group({
		task: '',
		priority: '',
		type: '',
		dueDate: ''
	});;

	constructor(private _formBuilder: FormBuilder) { }

	ngOnInit() {
	}

	public onSubmit(): void {
		console.log(this.form.value);
	}

}

import { TaskService } from './../task.service';
import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { Task } from './../../common/task';

@Component({
	selector: 'jarvis-add-task',
	templateUrl: './add-task.component.html',
	styleUrls: ['./add-task.component.less'],
})
export class AddTaskComponent implements OnInit {
	public form: FormGroup = this._formBuilder.group({
		description: '',
		priority: '',
		type: '',
		dueDate: '',
		category: '',
		title: '',
	});

	constructor(private _formBuilder: FormBuilder, private _taskService: TaskService) {}

	ngOnInit() {}

	public onSubmit(): void {
		this._taskService.createTask(this.form.value).subscribe((id: string) => {
			this.form.reset();
			console.log('create task : ', id);
		});
	}
}
